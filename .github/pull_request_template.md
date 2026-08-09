<!-- Fixing something in an existing skill? Delete the rest and just say what you ran. -->

**Claim:** #

**What ran:** OS, CLI version, what the run did, and which paths are untested. This becomes the
README's Verification status line, so claim only what you ran — "contract-tested, live run pending"
is a mergeable answer.

**New delegate skill?** The merge checklist is in [CONTRIBUTING.md](https://github.com/amElnagdy/delegate-skills/blob/master/CONTRIBUTING.md).
`node test/relay-smoke.mjs` checks package shape and registration for every skill on disk, then
drives each relay through timeout and abort; the relay code itself is read by hand.
