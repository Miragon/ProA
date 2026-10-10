# stress

Generator fixtures for `pnpm test`: loops, parallel split/join, nested and
event subprocesses, boundary events on subprocesses and call activities, three
pools with message flows in both directions, and most event definitions on c7
and c8. Validated in memory (parse, lint, DI); no expected.yaml.

`c7-coverage` and `c8-coverage` add what neither these fixtures nor the corpus
use (every remaining event definition per position, plain tasks, binding
variants), so that `node deploy-check.mjs test/fixtures/stress` deploys the
whole spec format on both engines. deploy-check generates this directory in
memory, since it has no `models/`.
