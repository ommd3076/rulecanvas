# RuleCanvas Troubleshooting & Recovery

## Malformed URI Handling
- Any malformed URI (such as /projects/%ZZ or invalid percent encodings) triggers RecoveryView.
- Never crashes React root; user is given a clean Return to Projects recovery CTA.

## Dirty State Recovery
- Unsaved drafts are retained locally in session storage if network connectivity drops.
