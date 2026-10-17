"""The lab's own model calls (the founder simulator and the judge) through Bedrock Converse, metered and
budget-guarded. Errors surface as AWS error codes only: messages can carry ARNs (with the account id)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

from conversation_lab.budget import Charge, Ledger, SpendGuard, estimate_tokens, token_cost
from conversation_lab.config import Price, foundation_model_id


class ConverseClient(Protocol):
    def converse(self, **kwargs: Any) -> dict[str, Any]: ...


class ModelCallError(Exception):
    """A Bedrock call failed; ``code`` is the AWS error code (never the message)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def error_code(exc: BaseException) -> str:
    response = getattr(exc, "response", None)
    if isinstance(response, dict):
        code = response.get("Error", {}).get("Code")
        if isinstance(code, str) and code.isascii() and len(code) <= 64:
            return code
    return type(exc).__name__


@dataclass
class ProbeResult:
    chosen: str | None
    #: model id -> "ok" or the AWS error code it answered with
    outcomes: dict[str, str] = field(default_factory=dict)


class LabModelClient:
    def __init__(
        self, *, client: ConverseClient, prices: dict[str, Price], guard: SpendGuard, ledger: Ledger
    ) -> None:
        self._client = client
        self._prices = prices
        self._guard = guard
        self._ledger = ledger

    def price(self, model_id: str) -> Price:
        price = self._prices.get(foundation_model_id(model_id))
        if price is None:
            raise ValueError(f"no price for {model_id}")
        return price

    def converse(
        self,
        model_id: str,
        *,
        system: str,
        messages: list[dict[str, Any]],
        max_tokens: int,
        temperature: float,
        purpose: str,
    ) -> str:
        price = self.price(model_id)
        text_in = system + "".join(
            block.get("text", "") for message in messages for block in message.get("content", [])
        )
        self._guard.reserve_lab(token_cost(price, estimate_tokens(text_in), max_tokens))
        try:
            response = self._client.converse(
                modelId=model_id,
                system=[{"text": system}],
                messages=messages,
                inferenceConfig={"maxTokens": max_tokens, "temperature": temperature},
            )
        except Exception as exc:  # noqa: BLE001 - botocore raises many types; only the code is kept
            raise ModelCallError(error_code(exc)) from None
        usage = response.get("usage") or {}
        tokens_in = int(usage.get("inputTokens") or estimate_tokens(text_in))
        tokens_out = int(usage.get("outputTokens") or max_tokens)
        self._ledger.add(
            Charge(
                kind="bedrock",
                purpose=purpose,
                model=model_id,
                units_in=tokens_in,
                units_out=tokens_out,
                usd=token_cost(price, tokens_in, tokens_out),
            )
        )
        content = response.get("output", {}).get("message", {}).get("content", [])
        return "".join(block.get("text", "") for block in content if isinstance(block, dict)).strip()

    def probe(self, candidates: tuple[str, ...]) -> ProbeResult:
        """The first candidate that answers a one-token request (each probe costs a few micro-dollars)."""
        result = ProbeResult(chosen=None)
        for model in candidates:
            try:
                self.converse(
                    model,
                    system="Answer with one word.",
                    messages=[{"role": "user", "content": [{"text": "Say ok."}]}],
                    max_tokens=4,
                    temperature=0.0,
                    purpose="probe",
                )
            except ModelCallError as exc:
                result.outcomes[model] = exc.code
                continue
            result.outcomes[model] = "ok"
            result.chosen = model
            break
        return result


def user(text: str) -> dict[str, Any]:
    return {"role": "user", "content": [{"text": text}]}


def assistant(text: str) -> dict[str, Any]:
    return {"role": "assistant", "content": [{"text": text}]}
