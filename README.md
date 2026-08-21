# moc-hackathon

The live visualiser for the Tekdi AI Product Development Hackathon, served at
**https://tekdi.github.io/moc-hackathon**.

Everything in this repository is generated. It is rebuilt and force-pushed by
the `publish-site` workflow in `tekdi/moihackathon-brain` on every push to that
repo's `main`, so any edit made here is overwritten on the next update.

To change the page, change the source:

| What | Where |
|---|---|
| The data on the page | The entity files in `tekdi/moihackathon-brain` — log an update |
| The page itself | `site/` in `tekdi/moihackathon-brain` |
| What gets published | `REDACTED_FIELDS` in that repo's `scripts/build_site.py` |

Pages serves this from `main` at the repository root.
