# n8n-nodes-miravig

Detect and mask sensitive data in your n8n workflows **before** text is sent to an LLM — then restore your own business terms in the response.

Miravig is a community node for [n8n](https://n8n.io). It runs entirely on your n8n instance: the text you analyze is never sent to Miravig. It uses the same detection engine as the Miravig browser extension and web app.

- **Detection is free and unlimited.**
- **Automatic masking and the business glossary** require an active Miravig subscription (one license key, shared with the extension and web app).

[Full documentation](https://www.miravig.com/mode-emploi-n8n.html) · [Pricing](https://www.miravig.com/tarifs.html) · [Miravig](https://www.miravig.com)

## Installation

Self-hosted n8n: **Settings → Community Nodes → Install**, then enter `n8n-nodes-miravig`.
See the [n8n community nodes guide](https://docs.n8n.io/integrations/community-nodes/installation/).

## Operations

One node, one **Operation** parameter:

| Operation | Where | What it does |
|---|---|---|
| **Mask** | Before your LLM node | Detects sensitive data; masks it if *Automatic Masking* is on (licensed). |
| **Unmask** | After your LLM node | Restores the original values of your business-glossary terms in the model's answer. |

Typical chain:

```
Trigger → Miravig (Mask) → LLM node → Miravig (Unmask) → rest of workflow
```

The node can also be used as a tool by an AI Agent.

## What it detects

Emails, IBANs, bank cards, phone numbers, API keys and secrets, and national identification numbers. For 24 countries the official checksum is verified (France, Spain, Portugal, Germany, Italy, Switzerland, Australia, Canada, Belgium, Austria, Norway, Finland, Netherlands, Poland, Czechia, Slovakia, Croatia, Ireland, Iceland, Romania, Bulgaria, Slovenia, Lithuania, Estonia). Denmark, Latvia and the United States (SSN) have no reliable public checksum, so they are detected by format and context only. Your own `{{ $json.field }}` expressions are never touched.

Native categories are replaced by one-way tokens such as `[EMAIL_HIDDEN]`.

## Business glossary

Add your own sensitive terms (project names, clients, internal codes). They are replaced by numbered tokens (`[TERM_G1]`…) that **Unmask** restores. Paste the **same glossary JSON** in the Mask and the Unmask nodes:

```json
[
  { "term": "ProjectPhoenix", "id": 1, "groups": ["General"] },
  { "term": "LegacyClient" }
]
```

If the two glossaries differ, Unmask warns you in its output instead of failing silently.

> **LLM nodes and the `miravig` field.** Some nodes (e.g. *Basic LLM Chain*) rebuild their output and drop the `miravig` field used for the glossary consistency check. Unmask still restores your terms and tells you the check was skipped. To keep the check, add an **Edit Fields** node after the LLM with *Include Other Fields* on, and set `miravig` to `{{ $('Miravig (Mask)').item.json.miravig }}`.

## Behavior on detection

- **Pass Through and Annotate** (default) — workflow continues, detections listed in the output.
- **Stop Workflow** — stops if sensitive data is found.
- **Route flagged items to a second output** — optional.

## License

Create a **Miravig License** credential and paste your license key (received by email after subscribing). Your key covers up to 3 activations, shared across devices and n8n instances. The credential test checks the key against the Miravig license service.

Only the license key is checked online (about once every 15 minutes, cached). If the service is unreachable, the node uses your last verified status; with no cached status, you choose whether to stop or continue without the licensed features (*On License Check Failure*).

## Compatibility

Tested on n8n 2.x, self-hosted.

## Support

Questions or bugs: contact@miravig.com or open an issue on [GitHub](https://github.com/justinc2209/n8n-nodes-miravig/issues).

## License

[MIT](LICENSE)
