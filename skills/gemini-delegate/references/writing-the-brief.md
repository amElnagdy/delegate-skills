# Writing the brief

Gemini receives only the brief and the workspace it can inspect. Include:

1. The outcome and acceptance criteria.
2. Relevant current state and files to inspect.
3. What may change and what must remain untouched.
4. The project's real gates (test, lint, build, typecheck).
5. A report contract: summarize edits, tests, remaining risk, and do not commit or push.

Keep one bounded concern per dispatch. Do not paste secrets, tokens, cookies, private keys, or
provider session material. Prefer a path or an environment-variable name; Gemini can read the
workspace itself. URLs in a brief may be treated as model context, so do not include sensitive links.

Example:

```text
Implement the parser fix in src/parser.ts and its tests only. Preserve the public API and do not
touch generated files. Run npm test and npm run lint. Do not commit or push. Report files changed,
commands run, and any unresolved failure.
```

