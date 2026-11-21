# sokoban-solver-01-run-20261121

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/fadliferdian28/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/fadliferdian28/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver. Every generated level is a 1-wide hallway with 1–4 rooms off it, and a box pushed out of a room can never come back — so each room is an independent puzzle and the level optimum is the sum of the rooms' optima. This solver splits the board into rooms and solves each room on its own with A* over pushes (state = sorted boxes + the player's reachable region; heuristic = cheapest box-to-goal assignment over BFS distances through walls alone), pruned by dead squares, frozen 2×2 blocks and frozen boxes, then stitches the rooms together by walking the player through the hallway. Deterministic by construction: fixed work budgets, no clock, no randomness.

## Results

Practice set: **1,000,000 / 1,000,000** — all 5 instances solved at P* (13/16/29/47/60 pushes), in ~0.5s for the whole set. Three extra sets drawn from other seeds also score 1,000,000 each. The house baseline (plain-astar 1.0.0) scores 200,000 on the practice set.

## Run it

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads `/input/<id>/level.txt` (or `$MAKEFUN_INPUT_DIR`), writes `/output/<id>/solution.txt`. Node 22, standard library only.

---

<sub>Entered on [make.fun](https://make.fun/?ref=effxtzzc&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
