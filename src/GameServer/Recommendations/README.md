# Recommendations

Players and bots share a real calendar day beginning at 00:00 UTC. Characters
at levels 10–19, 20–39 and 40+ can give 3, 6 and 9 recommendations respectively.
Unused allowance does not carry over. Received scores range from 0 to 255 and
decay by 1, 2 or 3 per elapsed real day, including offline days. A fresh day is
applied on login, before a grant, or by the online publication loop.

Migration 77 installs persistent day/spending/revision columns, a recommendation
journal with a unique directed pair per day, and shared-hunt progress. The giver,
recipient and journal entry change in one transaction. Relogging, restarting,
duplicate packets and concurrent givers cannot bypass the limits. A backwards
clock does not restore a consumed allowance. Changes to level recalculate the
allowance against the amount already spent that day.

Autonomous bot recommendations use committed interaction evidence. Shared-hunt
receipts must contain an accumulated hour of confirmed combat activity, and
the relationship must be friendly. Native positive hits measure short active
intervals with the same live party registrations; solo hits, retirement and
offline gaps earn no time. Successful eligible group kills release that time
into hunt episodes, at most once per pair per 30 minutes. Cold parties carry
their simulated combat time in the committed party body and release it in the
same accepted outcome. Wall-clock gaps between kills never count as activity.
Strong friendship (trust at least 10, affinity at least 5, hostility below 2)
can motivate a recommendation on another positive interaction. A completed
purchase can qualify when it fulfils the active equipment target or delivers
at least half an hour of value from its validated economic need. Hostile
personal history prevents friendship/trade/leader recommendations.

Cooperation between clan members gives the clan leader an additional
opportunity to receive a recommendation. This spends the giver's regular
allowance and obeys the same directed-pair restriction. Ordinary autonomous
recipients are bots; a member may also support a human clan leader.

Migration 78 discards old progress inferred from gaps, preserving scores and
daily spending. Bot decisions run in the same SQL transaction as accepted hot/cold evidence
or physical trades. Rejected outcomes create no recommendations. Publication
reads the committed journal once per second and updates registered actors.
Player grants publish immediately. Both native 0xb9 and action 0x28 enter the
same service. UserInfo and CharInfo contain real recommendation counters; the
C4 client uses the received score to render its blue name tint. Retired world
registrations cannot give/receive player requests or publish packets. The base name
color field follows Lisvus and remains white.
