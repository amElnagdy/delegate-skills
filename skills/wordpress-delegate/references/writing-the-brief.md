# Writing the brief

A brief is the entire task as the implementer will see it. It runs in a fresh process with **no
memory of your conversation, no access to your prior notes, and no shared context** — only the text
sent and whatever it can read from the working tree.

This skill changes what you have to write, not how much rigour the brief needs. The relay prepends a
standing WordPress preamble to every fresh brief, so you write the part no preamble can know.

## What the preamble already covers

Read the exact text with `node "<skill-dir>/scripts/relay.mjs" --print-preamble` — that is the
canonical copy, and it is what the implementer actually receives. In summary it fixes:

- **Security as a property of every line** — nonce *and* capability on state-changing requests,
  sanitize on input, escape at output, `$wpdb->prepare()` for every interpolated value, superglobals
  and REST payloads treated as hostile.
- **Use the platform** — never edit core or a third-party plugin in place, extend through hooks and
  filters, child themes for theme changes, prefer an existing WordPress API to a hand-rolled one,
  enqueue rather than print tags.
- **Maintainability** — WordPress Coding Standards, match the file being edited over any general
  rule, prefix every global symbol, no dead code and no abstraction without a second caller.
- **Backward compatibility** — public hooks, filters, shortcodes, REST routes, and option shapes are
  contracts; guard every dependency on another plugin and degrade cleanly when it is absent.
- **Performance** — no queries in loops, no unbounded queries, caches with an explicit invalidation
  path, nothing large in autoloaded options.
- **The commit boundary** — do not `git add` or `git commit`; leave the work in the working tree.

On top of that, the relay appends **domain notes** for whatever its keyword scan detected —
WooCommerce, Elementor, ACF, WPForms, performance, database, security, integrations, hosting,
deployment. The notes are a hint from a scan of your brief's wording, not a survey of the working
tree, and the block says so to the implementer. If the brief is about HPOS but never says
"WooCommerce", the notes will not fire — check with `--dry-run` and name the domain in the brief if
it matters.

Do not restate any of this. A brief that repeats the preamble spends tokens and buries the part that
is actually specific to your task.

## What only you can supply

The preamble knows WordPress. It does not know *your* WordPress. These are the facts a delegated
WordPress task fails on, and none of them are guessable:

- **Which repo is the repo.** A whole install, `wp-content/`, one plugin, one theme? Set `--cd`
  accordingly and say in the brief what is in scope and what merely sits nearby.
- **Versions that constrain the change.** PHP, WordPress, and the versions of the plugins being
  extended — WooCommerce, Elementor, and ACF all move APIs between majors. "Compatible with our
  Woo version" is not a constraint; the number is.
- **The real gate commands.** Read the repo's `CLAUDE.md` / `AGENTS.md` / `composer.json` /
  `package.json` / `Makefile` and copy them in verbatim: `composer test`, `vendor/bin/phpunit`,
  `vendor/bin/phpcs --standard=WordPress`, `npm run build`, `wp-env run tests-wordpress ...`. A brief
  that says "run the tests" gets an implementer that guesses, or skips.
- **The prefix and the text domain.** Every global symbol takes the project's prefix and every string
  takes the project's text domain — the preamble says so, but only your brief knows what they are.
- **What must not move.** Templates other themes override, hooks other plugins listen on, an option
  shape a migration depends on. This is the list that keeps a fix from becoming a refactor.
- **Whether the site is live, and what that forbids.** No schema change without a migration path, no
  destructive `wp` command, no writes to production data.

## The shape that works

```xml
<task>
One or two sentences: the concrete job and where it lives. Then the specifics — current state, what to
change, and explicitly what to leave untouched.
</task>

<environment>
Repo root: wp-content/plugins/acme-bookings (this is what --cd points at)
PHP 8.1 · WordPress 6.5 · WooCommerce 8.9 (HPOS enabled) · ACF Pro 6.2
Prefix: acme_  ·  Text domain: acme-bookings
Live site: yes — no schema changes without a versioned upgrade routine.
</environment>

<verification_loop>
Run these before finishing and fix anything they surface, don't just report it:
  <the project's real test command>
  <the project's real lint command, e.g. vendor/bin/phpcs --standard=WordPress src/>
  <the project's real build command, if assets are touched>
Confirm the working tree shows only the intended changes afterward.
</verification_loop>

<structured_output_contract>
End with a report in this exact shape:
  1. What changed and why
  2. Files touched
  3. Gate outcomes (paste the PHPUnit and PHPCS counts)
  4. Every hook, filter, option, or REST route added, changed, or deprecated
  5. Anything you deviated on, left open, or want a decision on
</structured_output_contract>
```

Item 4 in the report contract is WordPress-specific and worth keeping: the public surface is where a
WordPress change breaks other people's code, and it is the part a diff read makes you hunt for.

Add a block when the task profile calls for it — `<completeness_contract>` for open-ended debugging,
`<grounding_rules>` for a read-only audit, `<research_mode>` for a recommendation. The lane the relay
picks does not change what you must write; it changes who receives it.

## One task per brief

Keep each brief to a single, bounded job. "Audit the plugin, fix what you find, and document it" is
three lanes — the router will pick one, and the run will be muddled whichever it picks. Split it: an
audit dispatch (read-only, routes to `grok`), then a fix dispatch per finding, then a docs dispatch
(routes to `kimi`). One brief → one run → one commit.

That split is also how routing is *meant* to be used. A brief that reads as one kind of work routes
confidently; a brief that reads as three routes at `contested` and tells you so.

## Premises freeze at dispatch

The implementer starts from the brief's facts and there is no steering channel mid-run. Audit the
`<environment>` block before sending — a wrong plugin version or a wrong assumption about HPOS
invalidates the whole run. If a premise turns out wrong while the run is live, stop it and
re-dispatch a corrected brief rather than discounting the output afterward; inspect the working tree
and reconcile any partial edits first.

## A worked example

```xml
<task>
In wp-content/plugins/acme-bookings, the AJAX endpoint acme_cancel_booking (src/Ajax/Cancel.php)
cancels a booking for any booking id the caller sends: it verifies no nonce and checks no capability,
and it interpolates $_POST['booking_id'] straight into a $wpdb->get_row() call. Fix all three: verify
a nonce, require the capability that already gates the admin screen (acme_manage_bookings), and
prepare the query. Touch only src/Ajax/Cancel.php, the JS that calls it, and their tests. Leave the
booking model, the REST routes, and the admin screen untouched.
</task>

<environment>
Repo root: wp-content/plugins/acme-bookings (--cd points here)
PHP 8.1 · WordPress 6.5 · WooCommerce 8.9 (HPOS enabled)
Prefix: acme_  ·  Text domain: acme-bookings
Live site: yes. The endpoint is public-facing — do not change its action name or response shape.
</environment>

<verification_loop>
Run and make green before finishing:
  vendor/bin/phpunit --testsuite ajax
  vendor/bin/phpcs --standard=WordPress src/Ajax/
  npm run build
Confirm git status shows only Cancel.php, its JS, and their tests changed.
</verification_loop>

<structured_output_contract>
Report: (1) each of the three issues and your fix, (2) files touched, (3) PHPUnit and PHPCS counts,
(4) any hook, filter, option, or route added or changed, (5) anything you left open.
</structured_output_contract>
```

Note what is *not* in it: no reminder to escape output, no reminder about `$wpdb->prepare()`, no
"follow WordPress Coding Standards", no "don't commit". The preamble carries all of that. The brief
carries the booking system.

Send it with `relay.mjs` (see [dispatch-and-poll.md](dispatch-and-poll.md)); review the result and
commit it yourself (see [review-and-land.md](review-and-land.md)).
