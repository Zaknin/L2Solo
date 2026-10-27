# Clan wars

Clan feelings, formal declarations and military operations are separate state.
All formal changes use the queued SQLite writer. Migration 79 installs directed
declarations, their append-only history and versioned autonomous campaign plans.

## Native rules

Both clans require level 3 and 15 members when declaring. This follows the
historical C4 server and Lisvus request handlers; unlike some patch-note copies,
the same admission checks apply to a return declaration. An existing war does
not disappear if the roster later shrinks. Leaders or members with privilege
1024 can declare or withdraw. Allied and dissolving clans cannot start a war.
At most 30 outgoing declarations may be active. Each side owns its declaration;
withdrawing one leaves the other intact. A withdrawal is refused during the
clan's live combat or an active shared cold PvP encounter.
Removing a clan closes its declarations with versioned withdrawal records, so
workers and native actors cannot retain a war against a dissolved clan.

The C4 request opcodes are 0x4d (declare by clan name) and 0x4f (withdraw).
Accepting means declaring back. User commands 88, 89 and 90 display outgoing,
incoming and mutual lists. RelationChanged is built separately for each viewer,
including first visibility and later broadcasts. The white-target force-attack
behavior is retained; attackability is not a global purple flag.

Only mutual war exempts a white victim kill from PK/karma. Ordinary purple and
chaotic targets retain their existing rules. Native and cold deaths derive the
quarter XP penalty from the killer clan's outgoing declaration, as both retained
C4 implementations do, rather than requiring mutual war. Summons use their owner.

Authorised war attacks remain personal memory. Their captured declaration
revision is checked against persisted history before excluding them from clan
misconduct/collective blame. Ending war cannot retroactively turn a queued,
previously lawful memory event into a disciplinary offense.

## Autonomous decisions

[ClanWars] configures the system. The default declaration threshold is 40/100,
shifted within 35–45 by leader caution and assertiveness. At least three distinct
harm episodes within three days are also required. The leader needs available
generated members, while the native level, roster, alliance and authority checks
remain authoritative. A declaration is possible without knowing the enemy's
current position; a military expedition requires witnessed position information.

The recipient can accept based on its leader's character, available force,
reported enemies and existing hostility, or retain an incoming-only declaration.
Its own hostility need not cross the declaration threshold. Quiet campaigns and
repeated unsuccessful operations can cause withdrawal. Active combat refreshes
the campaign clock. After withdrawal, automatic redeclaration is held for six
hours. Player-managed clans are never given autonomous diplomatic commands.

The director runs as a bounded background registry job under existing admission
gates, independently of economic strategy. Disabling population, clan simulation
or ClanWars prevents autonomous decisions. LLM connectivity is not required.
Formal player commands and current diplomatic state remain separate.

## Operations

The director maintains publication-driven spot indexes, not per-bot world scans.
Cold sightings require a living clan observer and a visible living target within
900 horizontal units and 200 vertical units. Live observers read the actual
visible actor registrations and locations under the same distance limits.
Sightings expire after 15 minutes;
the persisted campaign retains at most twelve. The database does not supply
unobserved enemy positions.

A party operation records its enemy, witnessed destination, witness and time,
original home, start and expiry. It borrows an eligible same-clan ordinary party,
or forms 3–9 uncommitted generated bots with a healer and two damage roles in a
compatible level band. Required economic/quest parties and player companions
are not commandeered. Ready military demand waits for the next genuinely free
shared party slot before ordinary formation; it never exceeds the existing cap
or evicts a required contract. Every five seconds a separate cached readiness
pass preserves FIFO priority while the roster, mutual war and witnessed target
remain eligible. Loss of readiness, shutdown or disabling wars releases priority.
Each pass checks at most four queued clans and four other warring clans; one
formation attempt may run under the existing database/worker/loop-lag gates.
Waiting alone performs no SQL writes. Diplomatic reviews keep their own slower
round-robin schedule and cannot consume a military retry. At most four autonomous
operations run together by default. Formation fences the members and commits membership
atomically; declaration state is rechecked inside the membership transaction.

Normal trip builders, duration, geodata placement and whole-party arrival move
the expedition. Visible parties use native buffs, healing and spot travel; their
destination and return are also tracked when the whole party is hot. Orders can
move within the same sector to a witnessed location.
Every travel proposal fences the party revision, so an obsolete attack route
cannot overwrite a newer return order. The military route temporarily takes
precedence over an ordinary gear reroute, while economic goals remain stored.
The recorded home must lie inside its catalogued spot. A stale town location
paired with a farm id falls back to the farm's valid centre or arrival point;
new orders, cold travel, visible travel and return completion use that same
anchor. Existing persisted return orders are repaired once by the director.

At the destination a bounded existing PvP encounter attacks the tagged enemy
members. No personal revenge prerequisite or party peace vote is required.
Neutral companions remain outside the war roles. Native tactical risk/retreat,
peace zones, arena isolation and cold combat bounds still apply. The actual
impact transaction checks both declarations and their combined revision.
Stepped combat closes on a casualty to preserve the existing whole-roster
handoff invariant; the campaign can engage surviving tagged opponents again.

No visible enemies for a minute counts as clearing the area. Excess losses,
expiry, changed membership or ended war orders a physical return. Existing party
membership is retained after return. Operations and decisions survive restart;
future multiple-party fronts can coordinate several of these bounded operations.
An operation's deadline orders a return; it does not release the party's shared
slot. Capacity reclamation remains blocked while `warOperation` exists, including
an overdue return, and the queued writer rechecks this protection atomically.
Only physical arrival of the whole roster lets the director remove the order
and restore ordinary party-capacity rules.

While an order exists, market breaks may only refill combat consumables: shots,
arrows, potions and escape/resurrection scrolls. Gear, crafting inputs and loot
sales wait until the order is cleared, including during an overdue return.
Only one supply absence is reserved at a time; the returning member rejoins the
same operation and its military roster limit. An ended/replaced operation
releases the supply ticket instead of assigning an unrelated clan duty.

## Inspection and tests

GET /observer/api/clans/wars returns declarations and campaign decisions,
sightings, operation references and the last attempted encounter. It is a
read-only Observer endpoint.
It also exposes the bounded military queue, readiness reasons and the duration
of its latest cached refresh. A queued roster is displayed separately from a
deployed expedition and does not establish that travel or combat has occurred.
The Clans page displays mutual and one-sided declarations, current outgoing and
incoming expeditions, living roster counts, destinations, travel/combat/return
phases and recent persisted declarations/withdrawals. It polls every ten seconds
while the clan page is visible and live updates are enabled; failed updates retain
the last snapshot with a stale-data notice. The endpoint shares a two-second cache
and reads at most eighty recent diplomatic events per build.

The default suite includes test_clan_war_rules.js, test_clan_war_native.js,
test_clan_war_operations.js and test_clan_war_campaign.js. They cover eligibility,
directionality, persistence, white-target kill classification, neutral parties,
independent acceptance, raised hostility, stale impact rollback, discipline,
viewer masks, movement/arrival, party revision fences and return conditions.
test_world_observer_clan_wars.js covers bounded cached history, incoming raid
visibility, native movement/combat phases, escaped names and polling/error races.

For a real-world fixture, run scripts/clan-war-fixture.js with explicit --source
and --out paths. It creates a consistent SQLite backup and raises hostility only
in that new copy. It selects the strongest eligible existing clan grievance
unless --from/--to names are supplied. The adjacent .fixture.json preserves the
original clan snapshot. The live source is opened read-only and never modified.

scripts/probe-clan-war-fixture.js runs native diplomatic reviews and party
formation on that marked copy without starting a server. Its optional --free-slot
finishes one unrelated party through the normal atomic release path in the copy,
allowing formation to be checked when the source world is at the shared cap.
The probe does not execute combat; combat is covered by the campaign/native tests.
