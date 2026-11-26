from __future__ import annotations

import dataclasses
import json
from pathlib import Path

import pytest

from conversation_lab import config


def test_app_models_follow_the_production_config_while_luna_is_disabled() -> None:
    models = config.app_models()
    # The coach is Mistral Large 3 with Nova 2 Lite's US profile behind it; every turn is read first by Nova 2 Lite,
    # its sums too (gpt-oss-120b was late in production); the background purposes run on Nova (ADR-0025).
    assert models == config.AppModels(
        primary="mistral.mistral-large-3-675b-instruct",
        fallback="us.amazon.nova-2-lite-v1:0",
        embeddings="amazon.titan-embed-text-v2:0",
        background=config.BackgroundModels(
            primary="us.amazon.nova-2-lite-v1:0",
            fallback="global.amazon.nova-2-lite-v1:0",
            purposes=("classification", "eval", "ingestion", "seed"),
        ),
        understand=config.UnderstandSettings(
            enabled=True,
            model_id="us.amazon.nova-2-lite-v1:0",
        ),
    )
    # The lab's API process gets the same route (packages/ai router.ts reads these variables), the reading included.
    assert models.env() == {
        "MODEL_PRIMARY_ID": "mistral.mistral-large-3-675b-instruct",
        "MODEL_FALLBACK_ID": "us.amazon.nova-2-lite-v1:0",
        "MODEL_EMBEDDINGS_ID": "amazon.titan-embed-text-v2:0",
        "MODEL_BACKGROUND_PRIMARY_ID": "us.amazon.nova-2-lite-v1:0",
        "MODEL_BACKGROUND_FALLBACK_ID": "global.amazon.nova-2-lite-v1:0",
        "MODEL_BACKGROUND_PURPOSES": "classification,eval,ingestion,seed",
        "CORE_UNDERSTAND": "on",
        "MODEL_UNDERSTAND_ID": "us.amazon.nova-2-lite-v1:0",
    }
    assert models.for_purpose("turn") == (
        "mistral.mistral-large-3-675b-instruct",
        "us.amazon.nova-2-lite-v1:0",
    )
    assert models.for_purpose("distill") == models.for_purpose("turn")
    assert models.for_purpose("eval") == ("us.amazon.nova-2-lite-v1:0", "global.amazon.nova-2-lite-v1:0")
    # An A/B coach replaces the coach alone: the background route stays production's.
    ab = config.coach_app_models("us.amazon.nova-2-lite-v1:0", config.lab_models(), models)
    assert (ab.primary, ab.fallback, ab.background) == (
        "us.amazon.nova-2-lite-v1:0",
        "us.amazon.nova-2-lite-v1:0",
        models.background,
    )


def test_app_models_put_luna_first_once_enabled(tmp_path: Path) -> None:
    raw = json.loads(config.PRODUCTION_CONFIG.read_text(encoding="utf-8"))
    raw["models"]["luna"]["enabled"] = True
    path = tmp_path / "production.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    models = config.app_models(path)
    assert models.primary == "openai.gpt-6-luna"
    # The configured primary (the coach, Mistral Large 3) goes behind Luna.
    assert models.fallback == "mistral.mistral-large-3-675b-instruct"
    assert models.background == config.app_models().background


def test_lab_models_are_priced_and_shared_with_infra() -> None:
    lab = config.lab_models()
    assert lab.simulator[0] == "us.amazon.nova-pro-v1:0"
    assert lab.judge[0] == "us.amazon.nova-premier-v1:0"
    assert lab.prices["amazon.nova-premier-v1:0"] == config.Price(2.5, 12.5)
    # infra/cdk/src/lib/lab-models.ts reads the same file to grant exactly these models.
    source = (config.REPO / "infra" / "cdk" / "src" / "lib" / "lab-models.ts").read_text(encoding="utf-8")
    assert "join(REPO_ROOT, 'ops', 'lab', 'models.json')" in source


def test_a_luna_coach_is_never_judged_by_an_openai_model() -> None:
    lab = config.lab_models()
    luna = "us.openai.gpt-6-luna"
    assert luna in lab.live_coach
    assert lab.prices["openai.gpt-6-luna"] == config.Price(0.1375, 0.55)
    assert config.model_family(luna) == config.model_family("openai.gpt-6-luna") == "openai"
    # The A/B arm is Luna alone, behind no other model; production's background route stays.
    app = config.coach_app_models(luna, lab)
    assert (app.primary, app.fallback, app.background) == (luna, luna, config.app_models().background)
    policy, coach, judges = config.live_judges(luna, config.JUDGE_AUTO, lab)
    assert (policy, coach) == (config.JUDGE_AB, luna)
    assert judges == ("us.meta.llama4-maverick-17b-instruct-v1:0",)
    # Even with an OpenAI judge listed, a Luna coach never gets it (nor may it be named).
    candidates = (*lab.live_judge, "global.openai.gpt-6-luna")
    assert "global.openai.gpt-6-luna" not in config.judges_for(luna, candidates)
    with_openai = dataclasses.replace(lab, live_judge=candidates)
    with pytest.raises(ValueError, match="coach's own family"):
        config.live_judges(luna, "global.openai.gpt-6-luna", with_openai)


def test_the_live_workflow_offers_every_coach_of_models_json() -> None:
    text = (config.REPO / ".github" / "workflows" / "ops-live-evals.yml").read_text(encoding="utf-8")
    block = text[text.index("coach_model:") : text.index("judge_model:", text.index("coach_model:"))]
    listed = [line.strip()[2:] for line in block.splitlines() if line.strip().startswith("- ")]
    assert listed == [config.DEFAULT_COACH, *config.lab_models().live_coach]


def test_lab_models_refuse_an_unpriced_model(tmp_path: Path) -> None:
    raw = json.loads(config.MODELS_FILE.read_text(encoding="utf-8"))
    raw["judge"] = ["us.acme.model-v1:0"]
    path = tmp_path / "models.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(ValueError, match="no price"):
        config.lab_models(path)
    raw = json.loads(config.MODELS_FILE.read_text(encoding="utf-8"))
    raw["understand"].append({"id": "us.acme.model-v1:0", "efforts": []})
    path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(ValueError, match="no price"):
        config.lab_models(path)


def test_the_understand_call_is_the_deployments_unless_a_run_says_otherwise(tmp_path: Path) -> None:
    lab = config.lab_models()
    nova = "us.amazon.nova-2-lite-v1:0"
    # default adds nothing: the lab's API process keeps production's own reading (on, ADR-0025); off is still a choice.
    assert config.understand_env("default", "default", lab) == {}
    assert config.understand_env("off", "", lab) == {"CORE_UNDERSTAND": "off"}
    assert config.understand_env("on", nova, lab) == {"CORE_UNDERSTAND": "on", "MODEL_UNDERSTAND_ID": nova}
    oss = "openai.gpt-oss-120b-1:0"
    assert config.understand_env("on", "", lab, None, oss) == {
        "CORE_UNDERSTAND": "on",
        "MODEL_UNDERSTAND_SUMS_ID": oss,
    }
    for choice, sums, said in (
        ("on", "us.amazon.nova-pro-v1:0", "understand_sums_model must be"),
        ("off", oss, "understand_sums_model is for understand=on"),
    ):
        with pytest.raises(ValueError, match=said):
            config.understand_env(choice, "", lab, None, sums)
    for choice, model, said in (
        ("yes", "", "understand must be"),
        ("on", "us.amazon.nova-pro-v1:0", "understand_model must be"),
        ("default", nova, "understand=on"),
        ("off", nova, "understand=on"),
    ):
        with pytest.raises(ValueError, match=said):
            config.understand_env(choice, model, lab)
    # Production names it (ADR-0025): the lab's API process gets the same variables; a run's own go over them.
    assert config.app_models().understand == config.UnderstandSettings(enabled=True, model_id=nova)
    # What a client run reads with (and is planned at): default is production's, off turns it off, on names its own.
    production = config.app_models()
    assert (
        config.run_understand(production, config.understand_env("default", "", lab)) == production.understand
    )
    assert config.run_understand(production, config.understand_env("off", "", lab)).enabled is False
    assert config.run_understand(
        production, config.understand_env("on", "", lab, None, "openai.gpt-oss-20b-1:0")
    ) == (config.UnderstandSettings(enabled=True, model_id=nova, sums_model_id="openai.gpt-oss-20b-1:0"))
    raw = json.loads(config.PRODUCTION_CONFIG.read_text(encoding="utf-8"))
    raw["models"]["understand"] = {
        "enabled": True,
        "modelId": nova,
        "think": "low",
        "sumsModelId": oss,
        "sumsThink": "low",
    }
    path = tmp_path / "production.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    assert config.app_models(path).env() == {
        **config.app_models().env(),
        "CORE_UNDERSTAND": "on",
        "MODEL_UNDERSTAND_ID": nova,
        "MODEL_UNDERSTAND_THINK": "low",
        "MODEL_UNDERSTAND_SUMS_ID": oss,
        "MODEL_UNDERSTAND_SUMS_THINK": "low",
    }
    arm = config.coach_app_models(nova, lab, config.app_models(path))
    assert arm.understand == config.app_models(path).understand


def test_an_understand_run_is_never_split_above_its_cap() -> None:
    assert config.suites_for("understand") == ["understand"]
    assert "understand" not in config.suites_for("all")
    assert config.split_budget(2, ["understand"]) == {"understand": 2.0}
    with pytest.raises(ValueError, match="at most 2"):
        config.split_budget(2.01, ["understand"])
    assert config.budget_parts("understand", 2) == (2.0, 0.0)


def test_polly_is_metered_at_the_price_the_app_meters_it_at() -> None:
    assert config.polly_usd_per_million_characters("neural") == 16
    assert config.polly_usd_per_million_characters("generative") == 30


def test_foundation_model_id_strips_profile_prefixes() -> None:
    assert config.foundation_model_id("us.amazon.nova-pro-v1:0") == "amazon.nova-pro-v1:0"
    assert config.foundation_model_id("global.amazon.nova-2-lite-v1:0") == "amazon.nova-2-lite-v1:0"
    assert config.foundation_model_id("amazon.titan-embed-text-v2:0") == "amazon.titan-embed-text-v2:0"


def test_suites_and_budget_split() -> None:
    assert config.suites_for("all") == ["recall", "voice", "matrix", "ui"]
    assert config.suites_for("voice") == ["voice"]
    with pytest.raises(ValueError, match="suite must be"):
        config.suites_for("everything")
    split = config.split_budget(5, config.suites_for("all"))
    assert split == {"recall": 0.83, "voice": 0.83, "matrix": 1.66, "ui": 1.66}
    assert sum(split.values()) <= 5
    assert config.split_budget(5, ["recall"]) == {"recall": 5.0}
    for bad in (0, -1, 50.01):
        with pytest.raises(ValueError, match="budget"):
            config.split_budget(bad, ["recall"])


def test_budget_parts_never_exceed_the_suite_budget() -> None:
    for suite in config.SUITES:
        for budget in (0.83, 1.66, 5.0, 12.34):
            app, lab = config.budget_parts(suite, budget)
            assert app >= 0
            assert lab >= 0
            assert app + lab <= budget + 1e-9
    assert config.budget_parts("ui", 1.66) == (1.66, 0.0)
    assert config.budget_parts("matrix", 1.66) == (0.91, 0.75)
