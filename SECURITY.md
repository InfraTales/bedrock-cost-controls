# Security policy

## Reporting a problem

Please don't report security problems in public GitHub issues. Use GitHub's private vulnerability reporting on this repository (Security tab, then "Report a vulnerability").

It helps to include the file and line or the commit, the steps to reproduce, and what an attacker could do with it.

## How this stack protects itself

The short version is below. [docs/security.md](docs/security.md) has the details and the reasons.

- The function URL only accepts SigV4-signed requests from principals you grant both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`.
- The function's role can call `bedrock:InvokeModel` on two named models through named inference profiles, and read and update the budget table. Nothing else.
- A daily budget caps each user's spend, and `maxTokens` caps the output of every call.
- The gateway checks user IDs against a strict pattern before it puts them in a DynamoDB key.
