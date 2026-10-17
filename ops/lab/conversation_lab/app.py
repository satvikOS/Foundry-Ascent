"""The app as the platform owner sees it, through its own API (the evals client): lab caps, today's metered spend
and access codes for the synthetic founder."""

from __future__ import annotations

from typing import Any

from pydantic import SecretStr

from foundry_evals.client import FoundryClient

#: The seeded founder the lab talks as (packages/db seed: QuietQuad, coached by Corin's vEIR). Synthetic.
FOUNDER_NAME = "Maya Okafor-Lindqvist"


def lab_settings(app_budget_usd: float, baseline_usd: float, *, ui: bool = False) -> dict[str, Any]:
    """The app's own limits for a lab run: the platform's daily cap is the app's share of the budget (on top of
    whatever today already holds, normally nothing on a fresh database), the per-person cap the same (one founder
    talks), and the conversation limits generous enough that a scenario never hits them by accident. Within the
    contract's ranges (packages/contracts PlatformSettingsView). The UI suite gets the caps only: its specs expect
    the seeded defaults for everything else."""
    cap = round(min(100.0, baseline_usd + app_budget_usd), 2)
    caps = {"dailyUsdCapGlobal": cap, "dailyUsdCapPerPrincipal": round(min(50.0, cap), 2)}
    if ui:
        return caps
    return {
        "aiEnabled": True,
        "streamingEnabled": True,
        "callsEnabled": True,
        "dailyUsdCapGlobal": cap,
        "dailyUsdCapPerPrincipal": round(min(50.0, cap), 2),
        "maxTurnsPerSession": 200,
        "maxCallMinutes": 30,
        "dailyCallMinutesPerPrincipal": 240,
    }


class AppAdmin:
    def __init__(self, base_url: str, owner_code: SecretStr, *, client: FoundryClient | None = None) -> None:
        self.base_url = base_url
        self._owner_code = owner_code
        self.client = client or FoundryClient(base_url, request_id_prefix="lab")
        self.baseline_usd = 0.0

    def sign_in(self) -> None:
        self.client.wait_until_ready(max_wait_seconds=120)
        self.client.sign_in(self._owner_code)

    def usage(self) -> dict[str, Any]:
        return self.client.request("GET", "/admin/usage").json()

    def today_usd(self) -> float:
        return float(self.usage()["todayUsd"])

    def apply_lab_settings(self, app_budget_usd: float, *, ui: bool = False) -> dict[str, Any]:
        self.baseline_usd = self.today_usd()
        settings = lab_settings(app_budget_usd, self.baseline_usd, ui=ui)
        self.client.request("PATCH", "/admin/settings", json_body=settings)
        return settings

    def spent_since_start(self) -> float:
        return max(0.0, self.today_usd() - self.baseline_usd)

    def founder_code(self, display_name: str = FOUNDER_NAME) -> SecretStr:
        """A one-day access code for the seeded founder (a synthetic person)."""
        row = next(
            (r for r in self.client.list_admin_principals() if r.principal.display_name == display_name), None
        )
        if row is None:
            raise LookupError("the seeded founder was not found")
        issued = self.client.issue_access_code(row.principal.id, label="conversation lab", expires_in_days=1)
        return issued.access_code

    def founder(self, display_name: str = FOUNDER_NAME) -> FoundryClient:
        client = FoundryClient(self.base_url, request_id_prefix="lab-founder")
        client.sign_in(self.founder_code(display_name))
        return client

    def close(self) -> None:
        self.client.close()
