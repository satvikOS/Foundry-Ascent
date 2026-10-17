"""Amazon Bedrock models for the conversation lab: the LLM user simulator and the LLM judge.

One small wrapper over the Converse API (``bedrock-runtime``). ``boto3`` is imported only when a model is built,
so CI and the offline tests never need it (``pip install 'foundry_evals[lab]'`` in the lab). Credentials come from
the environment the lab workflow sets up (GitHub OIDC → a least-privilege role); nothing here reads or prints them.

Cost: every call reports Bedrock's token usage; the price per million tokens comes from ``PRICES`` (or explicit
overrides) and is charged against the run's ``--max-cost-usd`` together with the app's own turn costs. An unknown
model is priced at the most expensive row, so a budget cap stays conservative rather than optimistic.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from foundry_evals.matrix.judge import ModelReply

#: USD per million tokens (input, output), by model id prefix (cross-region "us." / "global." profiles included).
PRICES: tuple[tuple[str, float, float], ...] = (
    ("amazon.nova-micro", 0.035, 0.14),
    ("amazon.nova-lite", 0.06, 0.24),
    ("amazon.nova-2-lite", 0.33, 2.75),
    ("amazon.nova-pro", 0.8, 3.2),
    ("anthropic.claude-haiku-4-5", 1.0, 5.0),
    ("anthropic.claude-3-5-haiku", 0.8, 4.0),
    ("anthropic.claude-sonnet-4", 3.0, 15.0),
)
FALLBACK_PRICE = (3.0, 15.0)


def price_for(model_id: str) -> tuple[float, float]:
    """(input, output) USD per million tokens for ``model_id``; the dearest row when it is unknown."""
    bare = (
        model_id.split(".", 1)[1] if model_id.split(".", 1)[0] in ("us", "eu", "apac", "global") else model_id
    )
    for prefix, inp, out in PRICES:
        if bare.startswith(prefix):
            return inp, out
    return FALLBACK_PRICE


class LabDependencyError(RuntimeError):
    """boto3 is not installed (lab only)."""


class ModelCallError(RuntimeError):
    """A model call failed; the message carries the error class only, never request or response content."""


@dataclass
class ConverseModel:
    """A Bedrock model behind the Converse API. ``client`` is a ``bedrock-runtime`` client (built lazily)."""

    model_id: str
    region: str = "us-east-1"
    price_in: float | None = None
    price_out: float | None = None
    client: Any = None
    client_factory: Callable[[str], Any] | None = None

    def _client(self) -> Any:
        if self.client is None:
            factory = self.client_factory or _boto3_client
            self.client = factory(self.region)
        return self.client

    def cost(self, input_tokens: int, output_tokens: int) -> float:
        default_in, default_out = price_for(self.model_id)
        p_in = default_in if self.price_in is None else self.price_in
        p_out = default_out if self.price_out is None else self.price_out
        return (input_tokens * p_in + output_tokens * p_out) / 1_000_000

    def estimate(self, *, input_chars: int, max_tokens: int) -> float:
        """An upper estimate of one call (≈ 4 characters per token, the full output budget)."""
        return self.cost(input_chars // 4 + 1, max_tokens)

    def complete(self, *, system: str, user: str, max_tokens: int, temperature: float) -> ModelReply:
        client = self._client()  # a missing boto3 surfaces as LabDependencyError, not a failed call
        try:
            response = client.converse(
                modelId=self.model_id,
                system=[{"text": system}],
                messages=[{"role": "user", "content": [{"text": user}]}],
                inferenceConfig={"maxTokens": max_tokens, "temperature": temperature},
            )
        except Exception as exc:  # noqa: BLE001 - botocore raises many classes; only the class name is kept
            raise ModelCallError(f"bedrock converse failed: {type(exc).__name__}") from None
        try:
            parts = response["output"]["message"]["content"]
            text = "".join(p.get("text", "") for p in parts if isinstance(p, dict))
            usage = response.get("usage", {})
            inp, out = int(usage.get("inputTokens", 0)), int(usage.get("outputTokens", 0))
        except (KeyError, TypeError, ValueError, AttributeError):
            raise ModelCallError("bedrock converse returned an unexpected shape") from None
        return ModelReply(text=text, input_tokens=inp, output_tokens=out, cost_usd=self.cost(inp, out))


def _boto3_client(region: str) -> Any:
    try:
        import boto3
        from botocore.config import Config
    except ImportError as exc:
        raise LabDependencyError(
            "the LLM simulator and judge need boto3 (lab only): pip install 'foundry_evals[lab]'"
        ) from exc
    config = Config(retries={"max_attempts": 4, "mode": "standard"}, read_timeout=90, connect_timeout=10)
    return boto3.client("bedrock-runtime", region_name=region, config=config)
