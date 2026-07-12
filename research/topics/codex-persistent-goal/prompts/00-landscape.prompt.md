Research the current Codex persistent-goal interface for this exact use case: a user will open a
fresh Codex thread in a repository, give it one sentence telling it to read
`projects/P17-GOAL.md`, and manually create a persistent goal that must execute a very large,
multi-phase implementation program through verification and sign-off.

Survey primary sources widely but restrict public-source claims to official OpenAI documentation,
official OpenAI release material or source, current locally installed Codex help, and callable
capability metadata exposed in this session. Determine whether `/goal` is the official public name,
its exact accepted input shape, whether it accepts a file directly, how objective text and optional
token budgets work, how goals persist or resume across turns/context compaction, and how completion
or blocked status should be used. Search for exact and adjacent terminology. If the slash syntax or
persistence behavior is not publicly documented, say so and separate verified current-session facts
from recommendations.

Recommend the safest bootstrap and canonical-file pattern for P17. Cover what belongs in the
one-sentence bootstrap, what belongs in `projects/P17-GOAL.md`, how that file should reference the
project/plan/checklist/catalog/evidence artifacts, how an autonomous verification-and-correction
loop should be bounded, and which stop/approval conditions should remain human-controlled. Include
pitfalls and a ranked runner-up. State assumptions, conflicting evidence, confidence, and currency.
The result must be specific enough that the P17 goal file can be authored without another search.
