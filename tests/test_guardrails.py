"""Static regression guards for anti-amnesia scope and injection behavior."""
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "index.ts").read_text(encoding="utf-8")
CONFIG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
# User texts live in the i18n catalogs, no longer in index.ts: the guardrails
# must read them there or they stop protecting the invariant after a refactor.
CATALOGS = {
    lang: json.loads((ROOT / "i18n" / f"{lang}.json").read_text(encoding="utf-8"))
    for lang in ("en", "it")
}


class AntiAmnesiaGuardrails(unittest.TestCase):
    def test_session_id_is_part_of_card_identity(self):
        self.assertIn("ctx.sessionManager.getSessionId()", SOURCE)

    def test_project_card_is_not_loaded_as_active_memory(self):
        self.assertNotIn("readText(projectCardPath)", SOURCE)
        # The user warning lives in the catalog. The invariant is that the key
        # exists in EVERY language: the prose may change, the key may not.
        for lang in ("en", "it"):
            self.assertIn("copyCreated", CATALOGS[lang]["info"])
            self.assertIn("{dest}", CATALOGS[lang]["info"]["copyCreated"])

    def test_shared_draft_is_only_loaded_explicitly(self):
        self.assertIn("if (draftOnly)", SOURCE)

    def test_cross_session_key_is_rejected(self):
        self.assertIn("session-key-mismatch", SOURCE)

    def test_card_injection_has_no_hardcoded_global_rules(self):
        self.assertNotIn("REGOLA_CRONJOB_CARTA", SOURCE)

    def test_periodic_and_random_channels_remain_core_defaults(self):
        self.assertIs(CONFIG["periodicChannel"], True)
        self.assertIs(CONFIG["randomReviewChannel"], True)
        self.assertIn("periodicChannel: true", SOURCE)
        self.assertIn("randomReviewChannel: true", SOURCE)

    def test_topic_is_not_guessed_from_system_prompt(self):
        self.assertNotIn("extractTopic", SOURCE)
        self.assertNotIn("TOPIC RILEVATO", SOURCE)

    def test_config_boolean_values_are_validated(self):
        # The invariant is that a non-boolean value must never decide a channel.
        # The old guardrail asserted the line
        #   if (typeof cfg[field] !== 'boolean') cfg[field] = DEFAULTS[field];
        # which satisfied the letter but not the spirit: the string "false" (the
        # real case of a hand-edited config.json) is not a boolean, so it fell
        # back to the DEFAULT, which for periodicChannel/randomReviewChannel/
        # onCompact is true - and an explicit "off" became "on".
        self.assertIn("parseBooleanish", SOURCE)
        self.assertIn("cfg[field] = parsed ?? DEFAULTS[field]", SOURCE)

    def test_old_persistent_messages_are_filtered(self):
        self.assertIn("const cleanMessages = event.messages.filter", SOURCE)
        self.assertNotIn("deliverAs: 'nextTurn'", SOURCE)

    def test_saved_card_key_updates_in_place(self):
        self.assertIn("const target = globalCardPath();", SOURCE)
        self.assertNotIn('Chiave "${chiaveOriginale}" già esistente', SOURCE)


if __name__ == "__main__":
    unittest.main()
