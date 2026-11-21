// Sokoban solver: push-optimal, room by room.
//
// Idea: every generated level is a 1-wide hallway with 1-4 rooms off it.
// A box pushed out of a room through its door can never come back, so each
// room is an independent puzzle and the level optimum is the sum of the
// rooms' optima. We therefore split the board into rooms and solve each
// room on its own with A* over PUSHES (one push = one box moved one cell),
// then stitch the rooms together by walking the player through the hallway.
//
// Per-room search:
//   - state = sorted box squares + the player's reachable region, named by
//     its lowest square (the player can stand anywhere in the region, so
//     two states with the same boxes and region are the same state);
//   - heuristic = cheapest assignment of boxes to goals over BFS distances
//     through walls alone (admissible and consistent, so the first goal
//     state popped from the heap is push-optimal);
//   - pruning: dead squares (a box that no reverse pull from any goal can
//     reach can never be solved), frozen 2x2 blocks, and boxes frozen
//     against walls/boxes on both axes;
//   - deterministic throughout: fixed direction order, a sequence number
//     breaks heap ties, no clock, no randomness. Work is capped by a fixed
//     number of expansions, never by time, so two runs write identical bytes.
// If A* exhausts its cap on a room, a plain breadth-first push search with
// its own fixed cap runs as fallback; if that also gives up, a greedy
// best-first search (heuristic only) runs last, so an instance is always
// answered with a valid solution when one exists.
//
// Node 22, standard library only, no network, no clock reads.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Fixed work budgets (expansions), never the wall clock.
const ASTAR_CAP = 120_000;
const BFS_CAP = 250_000;
const GREEDY_CAP = 120_000;

const DIRS = [
  { dx: 0, dy: -1, step: 'u', push: 'U' },
  { dx: 0, dy: 1, step: 'd', push: 'D' },
  { dx: -1, dy: 0, step: 'l', push: 'L' },
  { dx: 1, dy: 0, step: 'r', push: 'R' },
];

type Board = { w: number; h: number; wall: Uint8Array; goals: number[]; boxes: number[]; player: number };

function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
  return { w, h, wall, goals: goals.sort((a, b) => a - b), boxes: boxes.sort((a, b) => a - b), player };
}

// Squares a lone box can ever stand on and still reach a goal: flood
// backwards from the goals, a pull at a time (box at x pulled to y = x - d
// needs the player to stand at y - d, so both y and y - d must be open).
function liveSquares(b: Board): Uint8Array {
  const live = new Uint8Array(b.w * b.h);
  const queue = [...b.goals];
  for (const g of b.goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const dir of DIRS) {
      const d = dir.dy * b.w + dir.dx;
      const y = x - d;
      if (y < 0 || y >= live.length) continue;
      if (!b.wall[y] && !b.wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

// Flood the player's reachable region from `from` (boxes block the way).
// Returns the region's lowest square and marks the region in `seen`.
function regionLow(b: Board, occ: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (const dir of DIRS) {
      const q = p + dir.dy * b.w + dir.dx;
      if (!b.wall[q] && !occ[q] && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

// Shortest walk from `from` to `to` around walls and boxes; lower-case steps.
function walkTo(b: Board, occ: Uint8Array, from: number, to: number): string | null {
  if (from === to) return '';
  const prev = new Int32Array(b.w * b.h).fill(-1);
  const how = new Array<string>(b.w * b.h);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const dir of DIRS) {
      const q = p + dir.dy * b.w + dir.dx;
      if (b.wall[q] || occ[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = dir.step;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

// Is the box just pushed onto `t` stuck in a full 2x2 block of walls and
// boxes that holds a box off its goal? Every box in such a block has both
// of its push directions blocked by the block itself, so it can never move.
function frozenBlock(b: Board, occ: Uint8Array, isGoal: Uint8Array, t: number): boolean {
  const w = b.w;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const c1 = a + 1;
    const c2 = a + w;
    const c3 = c2 + 1;
    if (a < 0 || c3 >= b.w * b.h) continue;
    if (!(b.wall[a] || occ[a]) || !(b.wall[c1] || occ[c1]) || !(b.wall[c2] || occ[c2]) || !(b.wall[c3] || occ[c3])) continue;
    if ((occ[a] && !isGoal[a]) || (occ[c1] && !isGoal[c1]) || (occ[c2] && !isGoal[c2]) || (occ[c3] && !isGoal[c3])) return true;
  }
  return false;
}

// Is box `t` frozen solid: blocked on both axes by wall or box, off goal?
function frozenSolid(b: Board, occ: Uint8Array, isGoal: Uint8Array, t: number): boolean {
  if (isGoal[t]) return false;
  const w = b.w;
  const blockedX = (b.wall[t - 1] || occ[t - 1]) && (b.wall[t + 1] || occ[t + 1]);
  const blockedY = (b.wall[t - w] || occ[t - w]) && (b.wall[t + w] || occ[t + w]);
  return blockedX && blockedY;
}

type SearchResult = { pushes: number; moves: string } | null;

// Push search over one board. mode 'astar' | 'bfs' | 'greedy'.
// A state is (sorted boxes, region-low). States are kept in arrays with a
// parent link; the move string is rebuilt by replaying the pushes.
function pushSearch(b: Board, cap: number, mode: 'astar' | 'bfs' | 'greedy'): SearchResult {
  const size = b.w * b.h;
  const n = b.boxes.length;
  const isGoal = new Uint8Array(size);
  for (const g of b.goals) isGoal[g] = 1;
  const live = liveSquares(b);
  if (b.boxes.some((x) => !live[x])) return null;
  const solved = (boxes: number[]): boolean => boxes.every((x) => isGoal[x]);

  // BFS distances from each goal through walls alone.
  const dist: Int32Array[] = b.goals.map((g) => {
    const d = new Int32Array(size).fill(-1);
    d[g] = 0;
    const q = [g];
    for (let qi = 0; qi < q.length; qi++) {
      const p = q[qi]!;
      for (const dir of DIRS) {
        const c = p + dir.dy * b.w + dir.dx;
        if (!b.wall[c] && d[c] < 0) {
          d[c] = d[p]! + 1;
          q.push(c);
        }
      }
    }
    return d;
  });

  // Cheapest box->goal assignment (brute-force permutations, n <= 4;
  // sum of per-box nearest-goal distances when n is larger).
  const heuristic = (boxes: number[]): number => {
    if (n === 0) return 0;
    if (n > 4) {
      let s = 0;
      for (const x of boxes) {
        let best = Infinity;
        for (const d of dist) if (d[x]! >= 0 && d[x]! < best) best = d[x]!;
        if (best === Infinity) return Infinity;
        s += best;
      }
      return s;
    }
    const perm = b.goals.map((_, i) => i);
    let best = Infinity;
    const rec = (k: number, sum: number): void => {
      if (sum >= best) return;
      if (k === n) {
        best = sum;
        return;
      }
      for (let i = k; i < perm.length; i++) {
        const dd = dist[perm[i]!]![boxes[k]!]!;
        if (dd < 0) continue;
        [perm[k], perm[i]] = [perm[i]!, perm[k]!];
        rec(k + 1, sum + dd);
        [perm[k], perm[i]] = [perm[i]!, perm[k]!];
      }
    };
    rec(0, 0);
    return best;
  };

  const occ = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  const keyOf = (boxes: number[], low: number): number => {
    let k = low;
    for (const x of boxes) k = k * size + x;
    return k;
  };

  const sBoxes: number[][] = [b.boxes.slice()];
  const sPlayer: number[] = [b.player];
  const sParent: number[] = [-1];
  const sG: number[] = [0];
  const best = new Map<number, number>();
  const startLow = (() => {
    for (const x of b.boxes) occ[x] = 1;
    const low = regionLow(b, occ, b.player, seen, ++stamp, stack);
    for (const x of b.boxes) occ[x] = 0;
    return low;
  })();
  best.set(keyOf(b.boxes, startLow), 0);

  // Binary heap on [priority, heuristic, sequence, state]. Priority is
  // g+h for A*, h for greedy, g for BFS (FIFO order via sequence).
  const heap: [number, number, number, number][] = [];
  const h0 = heuristic(b.boxes);
  if (h0 === Infinity) return null;
  const prio0 = mode === 'astar' ? h0 : mode === 'greedy' ? h0 : 0;
  heap.push([prio0, h0, 0, 0]);
  let seq = 1;
  const less = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  let expanded = 0;
  let found = solved(b.boxes) ? 0 : -1;
  while (heap.length > 0 && found < 0) {
    const [, , , s] = heapPop();
    const boxes = sBoxes[s]!;
    const g = sG[s]!;
    for (const x of boxes) occ[x] = 1;
    const low = regionLow(b, occ, sPlayer[s]!, seen, ++stamp, stack);
    if (best.get(keyOf(boxes, low)) !== s) {
      for (const x of boxes) occ[x] = 0;
      continue;
    }
    if (expanded >= cap) {
      for (const x of boxes) occ[x] = 0;
      return null;
    }
    expanded++;
    // The player's reachable region, for this expansion, is `seen`/`stamp`.
    const here = stamp;
    for (let bi = 0; bi < n && found < 0; bi++) {
      const box = boxes[bi]!;
      for (const dir of DIRS) {
        const d = dir.dy * b.w + dir.dx;
        const from = box - d; // square the player must stand on
        const to = box + d; // square the box moves to
        if (seen[from] !== here || b.wall[to] || occ[to] || !live[to]) continue;
        occ[box] = 0;
        occ[to] = 1;
        const dead = frozenBlock(b, occ, isGoal, to) || frozenSolid(b, occ, isGoal, to);
        let key = -1;
        let next: number[] | null = null;
        let h = Infinity;
        if (!dead) {
          next = boxes.slice();
          next[bi] = to;
          next.sort((x, y) => x - y);
          h = heuristic(next);
          if (h !== Infinity) key = keyOf(next, regionLow(b, occ, box, mark, ++stamp, stack));
        }
        occ[to] = 0;
        occ[box] = 1;
        if (dead || h === Infinity) continue;
        const prev = best.get(key);
        if (prev !== undefined && sG[prev]! <= g + 1) continue;
        const t = sBoxes.length;
        sBoxes.push(next!);
        sPlayer.push(box);
        sParent.push(s);
        sG.push(g + 1);
        best.set(key, t);
        const prio = mode === 'astar' ? g + 1 + h : mode === 'greedy' ? h : g + 1;
        heapPush([prio, h, seq++, t]);
        if (solved(next!)) {
          found = t;
          break;
        }
      }
    }
    for (const x of boxes) occ[x] = 0;
  }
  if (found < 0) return null;

  // Rebuild the move string: walk to each push square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = b.player;
  let boxes = b.boxes.slice();
  for (const s of path) {
    const nextBoxes = sBoxes[s]!;
    const from = boxes.find((x) => !nextBoxes.includes(x))!;
    const to = nextBoxes.find((x) => !boxes.includes(x))!;
    const d = to - from;
    const dir = DIRS.find((dd) => dd.dy * b.w + dd.dx === d)!;
    for (const x of boxes) occ[x] = 1;
    const walk = walkTo(b, occ, player, from - d);
    for (const x of boxes) occ[x] = 0;
    if (walk === null) return null; // cannot happen: the push square was reachable
    moves += walk + dir.push;
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

// Split a level into rooms: cut the hallway row's dead squares (open floor
// no box can ever reach a goal from) out of the floor; each remaining
// component holding boxes is a room. Null when the level is no set of rooms.
function roomsOf(level: Board): { squares: number[]; boxes: number[]; goals: number[] }[] | null {
  const live = liveSquares(level);
  const row = Math.floor(level.player / level.w);
  const cut = new Uint8Array(level.w * level.h);
  for (let i = row * level.w; i < (row + 1) * level.w; i++) if (!level.wall[i] && !live[i]) cut[i] = 1;
  if (level.boxes.some((x) => cut[x])) return null;
  const part = new Int32Array(level.w * level.h).fill(-1);
  const rooms: { squares: number[]; boxes: number[]; goals: number[] }[] = [];
  for (let s = 0; s < level.w * level.h; s++) {
    if (level.wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const dir of DIRS) {
        const q = squares[i]! + dir.dy * level.w + dir.dx;
        if (!level.wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const x of level.boxes) {
    if (part[x]! < 0) return null;
    rooms[part[x]!]!.boxes.push(x);
  }
  for (const g of level.goals) {
    if (part[g]! < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

// Replay moves on a level, returning the player's final square (for
// stitching rooms together). Assumes the moves are legal.
function endPlayer(level: Board, moves: string): number {
  let p = level.player;
  const occ = new Set(level.boxes);
  for (const ch of moves) {
    const dir = DIRS.find((dd) => dd.step === ch.toLowerCase())!;
    const d = dir.dy * level.w + dir.dx;
    const q = p + d;
    if (occ.has(q)) {
      occ.delete(q);
      occ.add(q + d);
    }
    p = q;
  }
  return p;
}

function solveRoom(b: Board): SearchResult {
  return pushSearch(b, ASTAR_CAP, 'astar') ?? pushSearch(b, BFS_CAP, 'bfs') ?? pushSearch(b, GREEDY_CAP, 'greedy');
}

function solve(text: string): string {
  const level = parseLevel(text);
  if (level.boxes.every((x) => level.goals.includes(x))) return '';
  const rooms = roomsOf(level);
  if (rooms === null) {
    const r = solveRoom(level);
    return r === null ? '' : r.moves;
  }
  let player = level.player;
  let moves = '';
  const done: boolean[] = rooms.map(() => false);
  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri]!;
    const wall = level.wall.slice();
    for (let oj = 0; oj < rooms.length; oj++) {
      if (oj === ri) continue;
      for (const x of done[oj]! ? rooms[oj]!.goals : rooms[oj]!.boxes) wall[x] = 1;
    }
    const sub: Board = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const r = solveRoom(sub);
    if (r === null) return ''; // no room solution found: answer empty, never illegal
    moves += r.moves;
    player = endPlayer(level, moves);
    done[ri] = true;
  }
  return moves;
}

for (const id of readdirSync(IN_DIR).sort()) {
  const moves = solve(readFileSync(join(IN_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
