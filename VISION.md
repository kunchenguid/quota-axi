# Vision

`quota-axi` exists so that an agent can know how much provider capacity is left before it commits to spending it.
It serves coding agents first and the people who run them second, and it turns local credential stores and first-party usage endpoints into one normalized quota snapshot.
It owns exactly one thing: the accurate report of local quota state.

## Accuracy is the first obligation

Reporting an accurate and useful number is the highest priority, and every other rule here yields to it.
A provider that is signed in and working must never read as signed out, because being wrong about the headline fact defeats the tool.
When a constraint would force quota-axi to publish something false, the constraint is narrowed to the smallest carve-out that restores the truth, and that carve-out is documented.
The primary flow is unattended, so anything that needs a human present is kept out of it and never becomes the path an agent depends on.

## It reports, the caller decides

quota-axi publishes figures, and the consumer decides what to do with them.
It never proxies a request, never intercepts traffic, and never mutates provider state to change an outcome.
A derived comparative signal is welcome when it is computed only from figures already reported, is documented, and is deterministic; `spendPriority` and `models --sort runway` ship on exactly those terms.
An opt-in surface that names a best scope is allowed on the same terms, because the alternative is every consumer reimplementing that comparison with worse handling of unknowns.
The default report stays in declaration order and carries no preference, so no column reads as a ranking the caller did not ask for.

## Least action on someone else's credentials

quota-axi acts on credentials other tools own, and it takes the least action that yields a true reading.
It never logs in, never creates an identity, and never runs anything that spends the quota being measured.
It never drives a browser or imports browser state or cookies, because a surface built for a human page is flaky and yields numbers it cannot verify.
Renewing a short-lived credential through its own first-party grant is allowed when that is what stands between quota-axi and an accurate report, and the renewed value is written back to the exact source it came from so later runs stay accurate too.
Running a vendor's own read-only command to learn auth state is allowed for the same reason and under the same limit.
A credential value leaves the process only as the bearer of the first-party request it authenticates or as a renewed value written back to its exact source, and is never printed, logged, cached, or written into a test fixture.
A credential the user supplies explicitly is as legitimate a source as one discovered on disk, because people run this in more shapes than one machine with one seat.

## Absent data stays absent

Every number reported is a number a provider reported or a figure derived from evidence quota-axi can trust.
It never invents a window duration, a reset deadline, a relationship between windows, or a percentage.
A conservative rule such as taking the lowest window as the effective bound applies only where that relationship is established as a fact about that provider, never as a default where relationships are unknown.
Uncertainty gets louder as it propagates: an unmeasurable scope publishes no row, `spendPriority` renders the literal `unknown` rather than `0`, and an unknown pace marker is omitted rather than drawn.
A number that has stopped being true is never served, even when labelled with its age and provenance, because it misleads the agent acting on it, and a failed read is reported as a failed read.

## Fixes land as machinery

A bug that can recur across providers is fixed once, in shared code, for every provider.
Credential selection, effective-availability aggregation, and the selection scalar each have exactly one implementation and one spelling.
Change is additive by default: a working path is never replaced to make a new one simpler, and a provider with a single valid credential behaves exactly as it did before.
A published shape change is deliberate and versioned, with the schema bump and its documentation in the same change, and the shape is never frozen against a change that makes the output truer or cheaper.
A deviation from prior behavior is named as a decision in the change that makes it, so nothing later reads as an accident.

## Consent at the credential boundary

Reading a secret the user has not offered requires the user's permission first.
The macOS Keychain is never read for a value on a plain call, `--allow-keychain-prompt` is the one-time bootstrap, and a non-secret hashed marker records the grant.
Keychain reads are pinned to the current account rather than an ambiguous service-wide query.
When a read is blocked, the report says so with a structured reason and a runnable remedy instead of reporting the user as signed out.

## The output is a budget

Default output is compact because its reader is an agent that pays per token to parse it.
Every block earns its place: consolidation that cuts output without losing a load-bearing fact is a win, and a value already published elsewhere is not published twice.
The `--tui` surface is a convenience for a human at a terminal, not a second product; it may use plainer words than the machine contract, and it never becomes a resident service or a graphical application.

## Scope

quota-axi is not a router, not a proxy, not a gateway, not a login manager, not a hosted service, and not a desktop application.
Coverage of popular agents is wanted and pursued on a best-effort basis, and it grows in this tree rather than through a third-party interface that would run unreviewed code against a user's credentials.
Where a vendor reports money as reliably as it reports capacity, reporting money is open to it; a signal that can only be made accurate for a few providers does not ship.
Adapter behavior is clean-room from a vendor's own observable behavior, and third-party data is attributed rather than republished.
The repo holds itself to the standard it asks of contributors, with no exemption for the contributions it most wants: every human pull request goes through the no-mistakes pipeline, generated files are regenerated rather than hand-edited, and tests exercise the published interface rather than the source text.

A change aligns when it makes a real quota fact readable that was previously unreadable or wrong, keeps every existing path working, and leaves the decision with the caller.
A change should be resisted when it publishes a number no provider supports, holds a boundary at the cost of a false report, spends the quota it is measuring, or grows the surface into a product this is not.
