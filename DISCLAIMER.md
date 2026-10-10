# Disclaimer and Acknowledgements

**English** | [简体中文](./DISCLAIMER.zh-CN.md)

> This document is part of [`dsh-xiaoyi`](./README.md). **By downloading, installing, copying, modifying or running this project you are deemed to have read, understood and accepted everything below. If you do not agree with any part of it, please do not use this project.**

---

## 1. The software is provided "as is"

This project is released under the **MIT License** and is provided **"AS IS"**, without warranty of any kind, express or implied, including but not limited to:

- merchantability, fitness for a particular purpose, and non-infringement;
- correctness, stability, uninterrupted operation, or freedom from errors;
- compatibility with any DSH version, Node.js version, operating system, or Huawei Cloud interface version.

The author makes **no commitment** to provide technical support, maintenance, updates, answers, or bug fixes.

---

## 2. You use it at your own risk

All risk and consequence arising from the use of this project rests **entirely with the user**, including but not limited to:

1. **Service disruption** — lost or duplicated messages, replies attached to the wrong task, repeated disconnects, sessions being created unexpectedly.
2. **Data loss** — corrupted session records, incomplete attachment downloads, overwritten or emptied `~/.dsh/xiaoyi/`, disk filled up by attachments.
3. **Impact on your system** — the plugin runs inside the DSH host process, so **a defect in the plugin can affect the host process itself** (connection flapping, reconnect storms, elevated resource usage).
4. **Cost** — any model usage, network traffic, cloud service, tunnel service or image-host fees triggered by this plugin.
5. **Account risk** — restriction, downgrade or suspension of your XiaoYi Open Platform account.

---

## 3. Credentials and account security

1. This plugin requires your **XiaoYi Open Platform AK / SK / agentId** in order to work.
2. **Those credentials are issued by Huawei, not by this project.** You must register and verify a Huawei developer account and apply for them yourself on the XiaoYi Open Platform (see the README). This project cannot create them, cannot obtain them for you, and cannot tell you whether your account is eligible.
3. These credentials are stored as **plain-text JSON** in `~/.dsh/xiaoyi/state.json` on your machine (and may therefore appear in your own configuration backups, disk snapshots or sync folders).
4. **Safekeeping is entirely your responsibility.** Do not enter anyone else's credentials; do not commit `state.json` to any Git repository, cloud drive, chat log or screenshot.
5. If credentials leak, whoever holds them can impersonate your agent when talking to Huawei Cloud. **If you suspect a leak, rotate (reset) the AK/SK on the platform immediately.**
6. This project does **not** upload credentials anywhere by itself; however, the author has no control over your runtime environment, dependency versions, or whether your system has been compromised.

---

## 4. Third-party services are unrelated to this project

This project merely **calls** the following third-party services. It has **no affiliation, agency, sponsorship or endorsement relationship** with them:

| Third party | Purpose | You must comply with |
| --- | --- | --- |
| **Huawei Cloud · XiaoYi Open Platform (OpenClaw mode)** | WebSocket connection and messaging channel | Its terms of service, developer agreement, content policies, quotas and billing rules |
| **catbox.moe** | Optional: outbound file upload (third-party image host) | Its terms of service and content policy; **uploading means your file leaves your machine** |
| **Any tunnel service** (e.g. localhost.run) | Optional: expose a local port as public https | Its terms of service and privacy policy |
| **DSH (DeepSeek Harness)** | Host runtime environment | Its own terms of use |

Any **change, rate limit, charge, discontinuation or ban** by these services may break this plugin. **The author accepts no responsibility and is under no obligation to adapt.**

---

## 5. Data and privacy

Understand the following data flows before use:

1. **Inbound messages** — text sent from XiaoYi is delivered as a user message into **your local DSH session**. It therefore becomes part of your session records and may be sent to whichever model provider you have configured.
2. **Inbound attachments** — attachments are **downloaded and stored on your machine** under `~/.dsh/xiaoyi/media/`, and the path is handed to the agent in the session. This plugin never cleans that directory automatically.
3. **Outbound files** —
   - `local` mode (default): the file is copied to `~/.dsh/xiaoyi/public/` and exposed through this plugin's own HTTP route plus a tunnel you provide;
   - `catbox` mode (must be enabled explicitly): the file is **uploaded to the third-party host catbox.moe**, which amounts to publishing it. Do not upload anything sensitive.
   - ⚠️ **In either mode, whether the file actually shows up in the XiaoYi client is outside this project's control.** The protocol accepts only a public https URL for outbound files, and what the client does with it is decided by the platform. **Text replies are unaffected.** Do not build a critical workflow on "the image will arrive on my phone".
4. **Logs** — runtime logs are written to `~/.dsh/xiaoyi/xiaoyi.log` and may contain session ids, task ids, file paths and error messages. Take care where those logs end up.
5. **The HTTP routes have no authentication** — `/xiaoyi/state` and `/xiaoyi/public/*` carry no identity check. Do **not** expose the DSH port directly to the internet.

---

## 6. Compliance and acceptable use

You agree **not** to use this project for:

- any purpose that violates the laws and regulations of the People's Republic of China or of your own jurisdiction;
- any purpose that violates the terms of service of Huawei Cloud or the XiaoYi Open Platform;
- spam, harassment, fraud, phishing, bulk marketing, or any other infringement of the rights of others;
- collecting, storing or distributing other people's personal information or private content without authorisation;
- circumventing or breaking any service's security mechanisms or access controls;
- anything that endangers network security, national security or the public interest.

**All legal responsibility arising from your use rests with you.**

---

## 7. Limitation of liability

To the maximum extent permitted by applicable law, **the author and any contributor shall not be liable** for any direct, indirect, incidental, special, punitive or consequential damages arising out of or related to this project, including but not limited to:

lost profits, lost data, business interruption, damaged equipment, banned accounts, third-party claims, or the cost of substitute services.

This limitation applies even if the author has been advised of the possibility of such damages.

---

## 8. This is not an official implementation

1. This project is an **independent third-party implementation**. It is **not** an official Huawei, XiaoYi or DeepSeek project, and has **not** been reviewed, certified or endorsed by them.
2. Its protocol implementation was written independently from **public documentation and publicly available reference artifacts**, and may contain **misunderstandings, missing fields or behavioural differences**. Official documentation takes precedence.
3. Names and trademarks such as **Huawei, XiaoYi, DeepSeek and catbox** belong to their respective owners and are used here for descriptive purposes only.

---

## 9. Miscellaneous

- The author may **modify, suspend or delete** this project at any time without prior notice.
- This document may be revised as the project evolves; the latest version in the repository governs.
- If this disclaimer conflicts with the body of the MIT License, **the MIT License prevails**. This document may be read as a further explanation of the license's "no warranty" and "limitation of liability" clauses.
- **The author is not a lawyer and this document is not legal advice.** For anything with real legal or commercial stakes, consult a qualified professional.

---

## Third-party notice

When implementing the protocol, this project referred to the published artifacts of **`@ynhcj/xiaoyi`** (author **ynhcj**, **MIT License**).

Should this project contain any copyrighted code fragment from it, the copyright belongs to its author:

```
Copyright (c) ynhcj — MIT License
```

That project declares its license in the `license` field of its `package.json`. This project is likewise released under the MIT License, and the two are compatible.

---

# Acknowledgements

- **HangZhouXi** (<https://github.com/HangZhouXi>) — project author
- **DeepSeek Flash** — this project was developed and debugged with its help
- **`@ynhcj/xiaoyi`** — this project's protocol implementation referred to that package's published artifacts. It is **not** an official Huawei project either; see the third-party notice above.
- **DSH (DeepSeek Harness)** — for providing the plugin host and ecosystem

---

*Last updated: 2026-10-10*
