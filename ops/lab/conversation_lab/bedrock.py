"""The lab's own model calls (the founder simulator and the judge) through Bedrock Converse, metered and
budget-guarded. Errors surface as AWS error codes only: messages can carry ARNs (with the account id)."""

from __future__ import annotations

import re
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


#: Claude models of the generation that thinks by default and refuses a sampling temperature other than its own.
_THINKING_CLAUDE = re.compile(r"anthropic\.claude-(?:haiku-5|sonnet-5|opus-(?:4-[78]|5)|fable|mythos)")
#: Of those, the ones that take ``thinking: disabled`` (Claude Haiku 5.5, at its default effort; the others refuse it).
_THINKING_CAN_STOP = re.compile(r"anthropic\.claude-haiku-5")
#: The fewest tokens a probe of a model that may think before its first word is given.
PROBE_TOKENS, PROBE_TOKENS_THINKING = 4, 64


def request_fields(model_id: str, max_tokens: int, temperature: float) -> dict[str, Any]:
    """What a model family's Converse request carries besides its prompt (as the app's adapter does, packages/ai
    nova.ts): the newest Claude models no temperature and no thinking, an OpenAI model no reasoning."""
    base = foundation_model_id(model_id)
    if _THINKING_CLAUDE.match(base):
        fields: dict[str, Any] = {"inferenceConfig": {"maxTokens": max_tokens}}
        if _THINKING_CAN_STOP.match(base):
            fields["additionalModelRequestFields"] = {"thinking": {"type": "disabled"}}
        return fields
    config = {"maxTokens": max_tokens, "temperature": temperature}
    if base.startswith("openai."):
        return {
            "inferenceConfig": config,
            "additionalModelRequestFields": {"reasoning": {"effort": "none"}},
        }
    return {"inferenceConfig": config}


def mask_aws(text: str) -> str:
    """``text`` without AWS account ids (12 digits), access key ids and session tokens."""
    out = re.sub(r"\b\d{4}-?\d{4}-?\d{4}\b", "<account>", text)
    out = re.sub(r"\b(?:AKIA|ASIA|AROA|AIDA)[A-Z0-9]{12,20}\b", "<key>", out)
    return re.sub(r"[A-Za-z0-9/+=]{80,}", "<token>", out)


@dataclass(frozen=True)
class Refusal:
    """What AWS said when it refused a call: private (sealed), account and key ids masked. It tells a missing permission
    from a model the account has not been given, which the code alone does not."""

    model: str
    purpose: str
    code: str
    message: str


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
        #: What AWS said when it refused a call (the first of each model, purpose and code).
        self.refusals: list[Refusal] = []

    def _keep(self, model_id: str, purpose: str, code: str, exc: BaseException) -> None:
        if len(self.refusals) >= 60:
            return
        if any((r.model, r.purpose, r.code) == (model_id, purpose, code) for r in self.refusals):
            return
        self.refusals.append(Refusal(model_id, purpose, code, mask_aws(str(exc))[:1000]))

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
                **request_fields(model_id, max_tokens, temperature),
            )
        except Exception as exc:  # noqa: BLE001 - botocore raises many types; the message is kept for the sealed report
            code = error_code(exc)
            self._keep(model_id, purpose, code, exc)
            raise ModelCallError(code) from None
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
                    max_tokens=PROBE_TOKENS_THINKING
                    if _THINKING_CLAUDE.match(foundation_model_id(model))
                    or foundation_model_id(model).startswith("openai.")
                    else PROBE_TOKENS,
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
