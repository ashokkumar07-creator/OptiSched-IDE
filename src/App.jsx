import React, { useState, useMemo, useEffect } from 'react';
import {
  Cpu,
  Play,
  Pause,
  RotateCcw,
  Zap,
  AlertTriangle,
  CheckCircle2,
  Sliders,
  Code2,
  GitBranch,
  Table2,
  BarChart3,
  Layers,
  ArrowRight,
  Clock,
  Sparkles,
  ChevronRight,
  ChevronLeft,
  Info,
  Terminal,
  Plus,
  Copy,
  Check,
  Activity,
  ShieldAlert,
  TrendingUp
} from 'lucide-react';

const PRESETS = [
  {
    id: 'raw-load-use',
    name: 'Memory Load-Use Stalls (Default)',
    badge: 'Classic ILP',
    description: 'Two independent memory loads interleaved with dependent arithmetic operations.',
    code: `LOAD R1, 0(R10)
ADD R2, R1, R3
LOAD R4, 4(R10)
MUL R5, R4, R6
SUB R7, R2, R5
STORE R7, 8(R10)`
  },
  {
    id: 'dual-tree',
    name: 'Dual Expression Tree',
    badge: 'High Speedup',
    description: 'Parallel address loads and multiplications feeding a final accumulator.',
    code: `LOAD R1, 0(R8)
MUL R2, R1, R9
LOAD R3, 4(R8)
MUL R4, R3, R10
LOAD R5, 8(R8)
ADD R6, R2, R4
ADD R7, R6, R5
STORE R7, 12(R8)`
  },
  {
    id: 'dot-product',
    name: 'Vector Dot-Product Kernel',
    badge: 'Compute Heavy',
    description: 'Four loads and two multiplications with a reduction tree and memory write.',
    code: `LOAD R1, 0(R20)
LOAD R2, 0(R21)
MUL R3, R1, R2
LOAD R4, 4(R20)
LOAD R5, 4(R21)
MUL R6, R4, R5
ADD R7, R3, R6
STORE R7, 0(R22)`
  },
  {
    id: 'register-hazards',
    name: 'RAW + WAR + WAW Register Reuse',
    badge: 'Multi-Hazard',
    description: 'Demonstrates True (RAW), Anti (WAR), and Output (WAW) dependencies when R1 is reused.',
    code: `LOAD R1, 0(R10)
ADD R2, R1, R3
STORE R2, 4(R10)
LOAD R1, 8(R10)
MUL R4, R1, R5
STORE R4, 12(R10)`
  }
];

const DEFAULT_LATENCIES = {
  LOAD: 3,
  STORE: 2,
  MUL: 4,
  DIV: 6,
  ALU: 1,
  ANTI_PENALTY: 1
};

// Parse assembly text into structured instruction objects
function parseInstructions(rawCode, latencies) {
  const lines = rawCode
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//') && !line.startsWith('#') && !line.startsWith(';'));

  return lines.map((line, index) => {
    const clean = line.split('//')[0].split('#')[0].trim();
    const parts = clean.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
    const opcode = (parts[0] || 'NOP').toUpperCase();
    const args = parts.slice(1);

    let defs = [];
    let uses = [];
    let category = 'ALU';
    let latency = latencies.ALU;

    const extractBaseReg = (operand) => {
      if (!operand) return null;
      const match = operand.match(/\((R\d+|SP|FP|GP)\)/i);
      if (match) return match[1].toUpperCase();
      if (/^(R\d+|SP|FP|GP)$/i.test(operand)) return operand.toUpperCase();
      return null;
    };

    if (opcode === 'LOAD' || opcode === 'LW' || opcode === 'LD') {
      category = 'LOAD';
      latency = latencies.LOAD;
      if (args[0]) defs.push(args[0].toUpperCase());
      const base = extractBaseReg(args[1]);
      if (base) uses.push(base);
    } else if (opcode === 'STORE' || opcode === 'SW' || opcode === 'SD') {
      category = 'STORE';
      latency = latencies.STORE;
      if (args[0]) {
        const src = extractBaseReg(args[0]);
        if (src) uses.push(src);
      }
      const base = extractBaseReg(args[1]);
      if (base) uses.push(base);
    } else if (opcode === 'MUL' || opcode === 'MULT' || opcode === 'IMUL') {
      category = 'MUL';
      latency = latencies.MUL;
      if (args[0]) defs.push(args[0].toUpperCase());
      args.slice(1).forEach((arg) => {
        const r = extractBaseReg(arg);
        if (r) uses.push(r);
      });
    } else if (opcode === 'DIV' || opcode === 'IDIV') {
      category = 'DIV';
      latency = latencies.DIV;
      if (args[0]) defs.push(args[0].toUpperCase());
      args.slice(1).forEach((arg) => {
        const r = extractBaseReg(arg);
        if (r) uses.push(r);
      });
    } else {
      category = 'ALU';
      latency = latencies.ALU;
      if (args[0]) defs.push(args[0].toUpperCase());
      args.slice(1).forEach((arg) => {
        const r = extractBaseReg(arg);
        if (r) uses.push(r);
      });
    }

    defs = Array.from(new Set(defs));
    uses = Array.from(new Set(uses));

    return {
      id: `I${index + 1}`,
      index,
      text: clean,
      opcode,
      category,
      latency,
      defs,
      uses
    };
  });
}

// Build Dependency DAG, Priorities, and Schedules
function analyzeAndSchedule(instructions, latencies) {
  const n = instructions.length;
  const edges = [];
  const adj = new Map();
  const revAdj = new Map();

  instructions.forEach((inst) => {
    adj.set(inst.id, []);
    revAdj.set(inst.id, []);
  });

  // Detect RAW, WAR, WAW dependencies between instruction i and j (i < j)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const u = instructions[i];
      const v = instructions[j];

      // 1. RAW (Read-After-Write): u writes R, v reads R, and no intervening instruction k overwrites R
      u.defs.forEach((reg) => {
        if (v.uses.includes(reg)) {
          let shadowed = false;
          for (let k = i + 1; k < j; k++) {
            if (instructions[k].defs.includes(reg)) {
              shadowed = true;
              break;
            }
          }
          if (!shadowed) {
            const edge = {
              id: `${u.id}->${v.id}-RAW-${reg}`,
              from: u.id,
              to: v.id,
              type: 'RAW',
              register: reg,
              weight: u.latency
            };
            edges.push(edge);
            adj.get(u.id).push(edge);
            revAdj.get(v.id).push(edge);
          }
        }
      });

      // 2. WAR (Write-After-Read): u reads R, v writes R
      u.uses.forEach((reg) => {
        if (v.defs.includes(reg)) {
          const alreadyConnected = edges.some((e) => e.from === u.id && e.to === v.id);
          if (!alreadyConnected) {
            const edge = {
              id: `${u.id}->${v.id}-WAR-${reg}`,
              from: u.id,
              to: v.id,
              type: 'WAR',
              register: reg,
              weight: Math.max(1, latencies.ANTI_PENALTY)
            };
            edges.push(edge);
            adj.get(u.id).push(edge);
            revAdj.get(v.id).push(edge);
          }
        }
      });

      // 3. WAW (Write-After-Write): u writes R, v writes R
      u.defs.forEach((reg) => {
        if (v.defs.includes(reg)) {
          let shadowed = false;
          for (let k = i + 1; k < j; k++) {
            if (instructions[k].defs.includes(reg)) {
              shadowed = true;
              break;
            }
          }
          const alreadyConnected = edges.some((e) => e.from === u.id && e.to === v.id);
          if (!shadowed && !alreadyConnected) {
            const edge = {
              id: `${u.id}->${v.id}-WAW-${reg}`,
              from: u.id,
              to: v.id,
              type: 'WAW',
              register: reg,
              weight: Math.max(1, latencies.ANTI_PENALTY)
            };
            edges.push(edge);
            adj.get(u.id).push(edge);
            revAdj.get(v.id).push(edge);
          }
        }
      });

      // 4. Memory ordering: STORE -> LOAD or STORE -> STORE conservative ordering
      if (u.category === 'STORE' && v.category === 'STORE') {
        const alreadyConnected = edges.some((e) => e.from === u.id && e.to === v.id);
        if (!alreadyConnected) {
          const edge = {
            id: `${u.id}->${v.id}-MEM`,
            from: u.id,
            to: v.id,
            type: 'WAW',
            register: 'MEM',
            weight: 1
          };
          edges.push(edge);
          adj.get(u.id).push(edge);
          revAdj.get(v.id).push(edge);
        }
      }
    }
  }

  // Compute Bottom-Up Critical Path Priority P(i)
  // P(i) = Latency(i) + max_{e in Out(i)} ( (e.weight - Latency(i)) + P(e.to) ) -> simplified standard height:
  // Standard latency-weighted height from node i to exit:
  // If i has no successors: P(i) = Latency(i)
  // If i has successors: P(i) = max_{e=(i,j)} ( e.weight + P(j) )
  const priorityMap = new Map();
  const longestSuccMap = new Map();

  for (let i = n - 1; i >= 0; i--) {
    const inst = instructions[i];
    const outEdges = adj.get(inst.id) || [];
    if (outEdges.length === 0) {
      priorityMap.set(inst.id, inst.latency);
      longestSuccMap.set(inst.id, null);
    } else {
      let bestVal = inst.latency;
      let bestSucc = null;
      outEdges.forEach((edge) => {
        const succPriority = priorityMap.get(edge.to) || 0;
        const candidate = edge.weight + succPriority;
        if (candidate > bestVal) {
          bestVal = candidate;
          bestSucc = edge.to;
        }
      });
      priorityMap.set(inst.id, bestVal);
      longestSuccMap.set(inst.id, bestSucc);
    }
  }

  // Compute DAG topological level (rank) for clean visual layout
  const levelMap = new Map();
  instructions.forEach((inst) => {
    const inEdges = revAdj.get(inst.id) || [];
    if (inEdges.length === 0) {
      levelMap.set(inst.id, 0);
    } else {
      let maxPrev = 0;
      inEdges.forEach((e) => {
        const prevLvl = levelMap.get(e.from) || 0;
        if (prevLvl + 1 > maxPrev) maxPrev = prevLvl + 1;
      });
      levelMap.set(inst.id, maxPrev);
    }
  });

  // Identify critical path nodes
  const maxPriority = Math.max(0, ...Array.from(priorityMap.values()));
  const criticalNodes = new Set();
  instructions.forEach((inst) => {
    if (priorityMap.get(inst.id) === maxPriority && maxPriority > 0) {
      let curr = inst.id;
      while (curr) {
        criticalNodes.add(curr);
        curr = longestSuccMap.get(curr);
      }
    }
  });

  // 1. Simulate Baseline (Original In-Order Program Sequence)
  const baselineSchedule = [];
  const baselineCycleLog = [];
  const baseIssueMap = new Map();
  let currentBaseCycle = 1;

  instructions.forEach((inst, idx) => {
    const inEdges = revAdj.get(inst.id) || [];
    let earliestReadyCycle = 1;
    let blockingEdge = null;

    inEdges.forEach((edge) => {
      const predIssue = baseIssueMap.get(edge.from) || 1;
      const readyAt = predIssue + edge.weight;
      if (readyAt > earliestReadyCycle) {
        earliestReadyCycle = readyAt;
        blockingEdge = edge;
      }
    });

    const stallsBefore = Math.max(0, earliestReadyCycle - currentBaseCycle);
    for (let s = 0; s < stallsBefore; s++) {
      baselineCycleLog.push({
        cycle: currentBaseCycle + s,
        type: 'STALL',
        instId: inst.id,
        reason: blockingEdge
          ? `Waiting on ${blockingEdge.from} (${blockingEdge.type} on ${blockingEdge.register})`
          : 'Pipeline hazard stall'
      });
    }

    const issueCycle = currentBaseCycle + stallsBefore;
    const completeCycle = issueCycle + inst.latency - 1;
    baseIssueMap.set(inst.id, issueCycle);

    baselineCycleLog.push({
      cycle: issueCycle,
      type: 'ISSUE',
      instId: inst.id,
      text: inst.text,
      opcode: inst.opcode,
      completeCycle,
      reason: stallsBefore > 0 && blockingEdge
        ? `Issued after ${stallsBefore} stall(s) for ${blockingEdge.from}`
        : 'Issued immediately without stall'
    });

    baselineSchedule.push({
      order: idx + 1,
      id: inst.id,
      text: inst.text,
      opcode: inst.opcode,
      category: inst.category,
      latency: inst.latency,
      priority: priorityMap.get(inst.id) || inst.latency,
      issueCycle,
      completeCycle,
      stallsIncurred: stallsBefore,
      stallReason:
        stallsBefore > 0 && blockingEdge
          ? `${blockingEdge.type} hazard on ${blockingEdge.register} from ${blockingEdge.from}`
          : 'None'
    });

    currentBaseCycle = issueCycle + 1;
  });

  const baselineTotalCycles =
    baselineSchedule.length > 0
      ? Math.max(...baselineSchedule.map((s) => s.completeCycle))
      : 0;
  const baselineTotalStalls = baselineSchedule.reduce((acc, s) => acc + s.stallsIncurred, 0);

  // 2. Simulate Priority List Scheduling (Optimized Out-of-Order / Compiler Scheduled)
  const remaining = new Set(instructions.map((i) => i.id));
  const optIssueMap = new Map();
  const optimizedSchedule = [];
  const optimizedCycleLog = [];
  const algorithmTrace = [];
  let currentOptCycle = 1;
  let safetyCounter = 0;

  const instById = new Map(instructions.map((i) => [i.id, i]));

  while (remaining.size > 0 && safetyCounter < 200) {
    safetyCounter++;

    // Find all instructions whose predecessors have been issued AND whose edge weights have elapsed
    const readyList = [];
    const stalledPredList = [];

    remaining.forEach((id) => {
      const inEdges = revAdj.get(id) || [];
      const allPredsIssued = inEdges.every((e) => optIssueMap.has(e.from));
      if (!allPredsIssued) return;

      let readyCycle = 1;
      let blocker = null;
      inEdges.forEach((e) => {
        const predIssue = optIssueMap.get(e.from);
        if (predIssue + e.weight > readyCycle) {
          readyCycle = predIssue + e.weight;
          blocker = e;
        }
      });

      if (readyCycle <= currentOptCycle) {
        readyList.push(instById.get(id));
      } else {
        stalledPredList.push({ inst: instById.get(id), readyCycle, blocker });
      }
    });

    if (readyList.length > 0) {
      // Sort by highest Priority P(i), tie-break by highest latency, then original program order
      readyList.sort((a, b) => {
        const pa = priorityMap.get(a.id) || 0;
        const pb = priorityMap.get(b.id) || 0;
        if (pb !== pa) return pb - pa;
        if (b.latency !== a.latency) return b.latency - a.latency;
        return a.index - b.index;
      });

      const chosen = readyList[0];
      const issueCycle = currentOptCycle;
      const completeCycle = issueCycle + chosen.latency - 1;
      optIssueMap.set(chosen.id, issueCycle);
      remaining.delete(chosen.id);

      // Count how many consecutive stalls occurred right before this instruction
      let stallsForThis = 0;
      for (let k = optimizedCycleLog.length - 1; k >= 0; k--) {
        if (optimizedCycleLog[k].type === 'STALL') stallsForThis++;
        else break;
      }

      const readyCandidatesStr = readyList
        .map((r) => `${r.id} (P=${priorityMap.get(r.id)})`)
        .join(', ');

      algorithmTrace.push({
        cycle: issueCycle,
        action: 'ISSUE',
        chosenId: chosen.id,
        chosenText: chosen.text,
        readyPool: readyCandidatesStr,
        rationale:
          readyList.length > 1
            ? `Selected ${chosen.id} over ${readyList
                .slice(1)
                .map((r) => r.id)
                .join(', ')} due to highest critical-path priority P=${priorityMap.get(chosen.id)}.`
            : `Issued ${chosen.id} (P=${priorityMap.get(chosen.id)}) — only ready instruction in pool.`
      });

      optimizedCycleLog.push({
        cycle: issueCycle,
        type: 'ISSUE',
        instId: chosen.id,
        text: chosen.text,
        opcode: chosen.opcode,
        completeCycle,
        reason: `Selected with Priority P=${priorityMap.get(chosen.id)}`
      });

      optimizedSchedule.push({
        order: optimizedSchedule.length + 1,
        originalOrder: chosen.index + 1,
        id: chosen.id,
        text: chosen.text,
        opcode: chosen.opcode,
        category: chosen.category,
        latency: chosen.latency,
        priority: priorityMap.get(chosen.id) || chosen.latency,
        issueCycle,
        completeCycle,
        stallsIncurred: stallsForThis,
        movedUp: chosen.index + 1 > optimizedSchedule.length + 1
      });

      currentOptCycle++;
    } else {
      // No instruction is ready at currentOptCycle -> insert a pipeline STALL bubble
      stalledPredList.sort((a, b) => a.readyCycle - b.readyCycle);
      const nextReady = stalledPredList[0];
      const reason =
        nextReady && nextReady.blocker
          ? `All candidates waiting on ${nextReady.blocker.from} (${nextReady.blocker.type} on ${nextReady.blocker.register})`
          : 'Waiting on in-flight instruction latency';

      optimizedCycleLog.push({
        cycle: currentOptCycle,
        type: 'STALL',
        instId: nextReady ? nextReady.inst.id : 'NONE',
        reason
      });

      algorithmTrace.push({
        cycle: currentOptCycle,
        action: 'STALL',
        chosenId: 'NOP / BUBBLE',
        chosenText: 'Pipeline Bubble',
        readyPool: 'Empty',
        rationale: reason
      });

      currentOptCycle++;
    }
  }

  const optimizedTotalCycles =
    optimizedSchedule.length > 0
      ? Math.max(...optimizedSchedule.map((s) => s.completeCycle))
      : 0;
  const optimizedTotalStalls = optimizedCycleLog.filter((c) => c.type === 'STALL').length;

  const enrichedInstructions = instructions.map((inst) => {
    const outEdges = adj.get(inst.id) || [];
    const inEdges = revAdj.get(inst.id) || [];
    const prio = priorityMap.get(inst.id) || inst.latency;
    const isCritical = criticalNodes.has(inst.id);
    const baseItem = baselineSchedule.find((b) => b.id === inst.id);
    const optItem = optimizedSchedule.find((o) => o.id === inst.id);

    return {
      ...inst,
      priority: prio,
      level: levelMap.get(inst.id) || 0,
      isCritical,
      slack: Math.max(0, maxPriority - prio),
      outEdges,
      inEdges,
      baseIssue: baseItem ? baseItem.issueCycle : 1,
      baseComplete: baseItem ? baseItem.completeCycle : 1,
      optIssue: optItem ? optItem.issueCycle : 1,
      optComplete: optItem ? optItem.completeCycle : 1
    };
  });

  const cyclesSaved = Math.max(0, baselineTotalCycles - optimizedTotalCycles);
  const speedup =
    optimizedTotalCycles > 0 ? (baselineTotalCycles / optimizedTotalCycles).toFixed(2) : '1.00';
  const stallReductionPct =
    baselineTotalStalls > 0
      ? Math.round(((baselineTotalStalls - optimizedTotalStalls) / baselineTotalStalls) * 100)
      : 0;
  const baseUtilization =
    baselineTotalCycles > 0 ? Math.round((n / baselineTotalCycles) * 100) : 100;
  const optUtilization =
    optimizedTotalCycles > 0 ? Math.round((n / optimizedTotalCycles) * 100) : 100;

  return {
    instructions: enrichedInstructions,
    edges,
    maxPriority,
    baselineSchedule,
    optimizedSchedule,
    baselineCycleLog,
    optimizedCycleLog,
    algorithmTrace,
    metrics: {
      instructionCount: n,
      baselineTotalCycles,
      optimizedTotalCycles,
      baselineTotalStalls,
      optimizedTotalStalls,
      cyclesSaved,
      speedup,
      stallReductionPct,
      baseUtilization,
      optUtilization
    }
  };
}

export default function App() {
  const [activePreset, setActivePreset] = useState(PRESETS[0].id);
  const [codeText, setCodeText] = useState(PRESETS[0].code);
  const [latencies, setLatencies] = useState(DEFAULT_LATENCIES);
  const [selectedInstId, setSelectedInstId] = useState(null);
  const [hoveredInstId, setHoveredInstId] = useState(null);
  const [activeRightTab, setActiveRightTab] = useState('all'); // 'all' | 'dag' | 'tables' | 'timeline'
  const [activeAlgoStep, setActiveAlgoStep] = useState('trace'); // 'trace' | 'rules'
  const [scrubberCycle, setScrubberCycle] = useState(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [quickInstText, setQuickInstText] = useState('ADD R8, R1, R4');
  const [hazardFilter, setHazardFilter] = useState('ALL'); // 'ALL' | 'RAW' | 'WAR' | 'WAW'

  const parsedInstructions = useMemo(
    () => parseInstructions(codeText, latencies),
    [codeText, latencies]
  );

  const analysis = useMemo(
    () => analyzeAndSchedule(parsedInstructions, latencies),
    [parsedInstructions, latencies]
  );

  const maxTimelineCycle = Math.max(
    1,
    analysis.metrics.baselineTotalCycles,
    analysis.metrics.optimizedTotalCycles
  );

  useEffect(() => {
    if (scrubberCycle > maxTimelineCycle) {
      setScrubberCycle(maxTimelineCycle);
    }
  }, [maxTimelineCycle, scrubberCycle]);

  useEffect(() => {
    if (!isPlaying) return undefined;
    const timer = setInterval(() => {
      setScrubberCycle((prev) => {
        if (prev >= maxTimelineCycle) {
          setIsPlaying(false);
          return 1;
        }
        return prev + 1;
      });
    }, 650);
    return () => clearInterval(timer);
  }, [isPlaying, maxTimelineCycle]);

  const activeHighlightId = hoveredInstId || selectedInstId;

  const handlePresetChange = (preset) => {
    setActivePreset(preset.id);
    setCodeText(preset.code);
    setSelectedInstId(null);
    setScrubberCycle(1);
    setIsPlaying(false);
  };

  const handleLatencyChange = (key, value) => {
    setLatencies((prev) => ({
      ...prev,
      [key]: Number(value)
    }));
  };

  const handleResetAll = () => {
    const defaultPreset = PRESETS[0];
    setActivePreset(defaultPreset.id);
    setCodeText(defaultPreset.code);
    setLatencies(DEFAULT_LATENCIES);
    setSelectedInstId(null);
    setScrubberCycle(1);
    setIsPlaying(false);
  };

  const handleAddQuickInstruction = (e) => {
    e.preventDefault();
    if (!quickInstText.trim()) return;
    setCodeText((prev) => `${prev.trim()}\n${quickInstText.trim()}`);
    setActivePreset('custom');
  };

  const handleCopySchedule = () => {
    const formatted = analysis.optimizedSchedule
      .map((s) => `${s.text.padEnd(20, ' ')} // Issue: C${s.issueCycle}, Priority: P=${s.priority}`)
      .join('\n');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(formatted);
      } else {
        const ta = document.createElement('textarea');
        ta.value = formatted;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    } catch (err) {
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    }
  };

  // Compute SVG DAG Node Coordinates
  const dagLayout = useMemo(() => {
    const nodes = analysis.instructions;
    if (nodes.length === 0) return { nodeCoords: new Map(), width: 680, height: 320 };

    const levels = new Map();
    let maxLvl = 0;
    nodes.forEach((n) => {
      const lvl = n.level || 0;
      if (lvl > maxLvl) maxLvl = lvl;
      if (!levels.has(lvl)) levels.set(lvl, []);
      levels.get(lvl).push(n);
    });

    const width = 760;
    const rowHeight = 105;
    const height = Math.max(320, (maxLvl + 1) * rowHeight + 60);
    const nodeCoords = new Map();

    levels.forEach((lvlNodes, lvl) => {
      const count = lvlNodes.length;
      const spacing = width / (count + 1);
      lvlNodes.forEach((n, idx) => {
        nodeCoords.set(n.id, {
          x: spacing * (idx + 1),
          y: 55 + lvl * rowHeight
        });
      });
    });

    return { nodeCoords, width, height };
  }, [analysis.instructions]);

  const filteredEdges = useMemo(() => {
    if (hazardFilter === 'ALL') return analysis.edges;
    return analysis.edges.filter((e) => e.type === hazardFilter);
  }, [analysis.edges, hazardFilter]);

  // Status at current scrubber cycle
  const baseAtScrubber = useMemo(() => {
    const issueEntry = analysis.baselineSchedule.find((s) => s.issueCycle === scrubberCycle);
    const stallEntry = analysis.baselineCycleLog.find(
      (c) => c.cycle === scrubberCycle && c.type === 'STALL'
    );
    const activeInFlight = analysis.baselineSchedule.filter(
      (s) => s.issueCycle <= scrubberCycle && s.completeCycle >= scrubberCycle
    );
    return { issueEntry, stallEntry, activeInFlight };
  }, [analysis, scrubberCycle]);

  const optAtScrubber = useMemo(() => {
    const issueEntry = analysis.optimizedSchedule.find((s) => s.issueCycle === scrubberCycle);
    const stallEntry = analysis.optimizedCycleLog.find(
      (c) => c.cycle === scrubberCycle && c.type === 'STALL'
    );
    const activeInFlight = analysis.optimizedSchedule.filter(
      (s) => s.issueCycle <= scrubberCycle && s.completeCycle >= scrubberCycle
    );
    return { issueEntry, stallEntry, activeInFlight };
  }, [analysis, scrubberCycle]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-cyan-500/30 selection:text-cyan-200">
      {/* Top IDE Header Bar */}
      <header className="sticky top-0 z-30 border-b border-slate-800/90 bg-slate-950/90 backdrop-blur-md px-4 lg:px-6 py-3">
        <div className="max-w-[1600px] mx-auto flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500/20 via-indigo-500/20 to-emerald-500/20 border border-cyan-500/40 flex items-center justify-center shadow-lg shadow-cyan-950/50">
              <Cpu className="w-5 h-5 text-cyan-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base sm:text-lg font-bold tracking-tight bg-gradient-to-r from-white via-cyan-100 to-indigo-300 bg-clip-text text-transparent">
                  OptiSched IDE
                </h1>
                <span className="text-[11px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                  List Scheduler &amp; DAG Visualizer
                </span>
              </div>
              <p className="text-xs text-slate-400 hidden sm:block">
                Real-Time Compiler Instruction Scheduling, Hazard DAG Analysis &amp; Pipeline Stall Optimizer
              </p>
            </div>
          </div>

          {/* Live Status Banner + View Filter Tabs */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="hidden xl:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs">
              <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-slate-400">Pipeline Gain:</span>
              <span className="font-mono font-semibold text-emerald-400">
                {analysis.metrics.cyclesSaved} Cycles Saved ({analysis.metrics.speedup}x Speedup)
              </span>
            </div>

            <div className="flex items-center bg-slate-900 p-1 rounded-lg border border-slate-800 text-xs">
              {[
                { id: 'all', label: 'Full Split-IDE', icon: Layers },
                { id: 'dag', label: 'DAG & Priority', icon: GitBranch },
                { id: 'timeline', label: 'Schedules & Gantt', icon: BarChart3 }
              ].map((tab) => {
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveRightTab(tab.id)}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md font-medium transition-all ${
                      activeRightTab === tab.id
                        ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 shadow-sm'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              onClick={handleResetAll}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 text-xs font-medium transition-colors"
              title="Reset to default sample code and latencies"
            >
              <RotateCcw className="w-3.5 h-3.5 text-slate-400" />
              <span>Reset</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Split-Screen IDE Workspace */}
      <main className="max-w-[1600px] mx-auto p-4 lg:p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* LEFT PANE: USER INPUT MODULE, LATENCY SLIDERS & STEP-BY-STEP ALGORITHM (4 Cols) */}
        <section className="lg:col-span-4 space-y-5">
          {/* 1. Benchmark Presets & Live Assembly Input */}
          <div className="rounded-2xl bg-slate-900/90 border border-slate-800/90 shadow-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between bg-slate-900/60">
              <div className="flex items-center gap-2">
                <Code2 className="w-4 h-4 text-cyan-400" />
                <h2 className="text-sm font-semibold text-slate-100">
                  1. Assembly Input Module
                </h2>
              </div>
              <span className="text-[11px] font-mono text-slate-400">
                {analysis.instructions.length} Instructions
              </span>
            </div>

            <div className="p-4 space-y-4">
              {/* Preset Selector Pills */}
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">
                  Benchmark Presets
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => handlePresetChange(preset)}
                      className={`text-left p-2.5 rounded-xl border transition-all ${
                        activePreset === preset.id
                          ? 'bg-cyan-500/15 border-cyan-500/50 text-cyan-100 shadow-sm'
                          : 'bg-slate-950/60 border-slate-800/80 text-slate-300 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1 mb-0.5">
                        <span className="text-xs font-semibold truncate">{preset.name}</span>
                      </div>
                      <span className="inline-block text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-cyan-300">
                        {preset.badge}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Code Editor Textarea with Line Indicators */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label
                    htmlFor="asm-editor"
                    className="text-[11px] font-semibold uppercase tracking-wider text-slate-400"
                  >
                    Assembly Instructions (Editable)
                  </label>
                  <span className="text-[11px] text-cyan-400 font-mono">
                    Format: OPCODE DEST, SRC1, SRC2
                  </span>
                </div>
                <div className="relative rounded-xl bg-slate-950 border border-slate-800 focus-within:border-cyan-500/60 transition-colors overflow-hidden">
                  <div className="flex">
                    <div className="select-none py-3 px-2.5 text-right font-mono text-xs text-slate-600 bg-slate-900/50 border-r border-slate-800/80 min-w-[2.5rem]">
                      {codeText.split('\n').map((_, i) => (
                        <div key={i} className="leading-6">
                          I{i + 1}
                        </div>
                      ))}
                    </div>
                    <textarea
                      id="asm-editor"
                      value={codeText}
                      onChange={(e) => {
                        setCodeText(e.target.value);
                        setActivePreset('custom');
                      }}
                      rows={Math.max(6, codeText.split('\n').length)}
                      spellCheck={false}
                      className="w-full bg-transparent py-3 px-3 font-mono text-xs sm:text-sm text-cyan-100 focus:outline-none leading-6 resize-y"
                      placeholder="Enter assembly instructions, one per line..."
                    />
                  </div>
                </div>
              </div>

              {/* Quick Append Instruction Bar */}
              <form onSubmit={handleAddQuickInstruction} className="flex gap-2">
                <input
                  type="text"
                  value={quickInstText}
                  onChange={(e) => setQuickInstText(e.target.value)}
                  placeholder="e.g. ADD R8, R1, R4"
                  aria-label="Quick append assembly instruction"
                  className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-cyan-500/60"
                />
                <button
                  type="submit"
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/30 text-xs font-medium transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Append</span>
                </button>
              </form>
            </div>
          </div>

          {/* 2. Configurable Hardware Latency Parameters */}
          <div className="rounded-2xl bg-slate-900/90 border border-slate-800/90 shadow-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between bg-slate-900/60">
              <div className="flex items-center gap-2">
                <Sliders className="w-4 h-4 text-indigo-400" />
                <h2 className="text-sm font-semibold text-slate-100">
                  2. Hardware Latency Parameters
                </h2>
              </div>
              <span className="text-[11px] font-mono text-indigo-300">Clock Cycles</span>
            </div>

            <div className="p-4 space-y-3.5">
              {[
                {
                  key: 'LOAD',
                  label: 'LOAD (Memory Read)',
                  min: 1,
                  max: 6,
                  desc: 'Cache hit / memory load delay before register value is ready',
                  color: 'accent-cyan-400'
                },
                {
                  key: 'MUL',
                  label: 'MUL (Integer Multiply)',
                  min: 1,
                  max: 8,
                  desc: 'Multi-cycle multiplier pipeline stage latency',
                  color: 'accent-indigo-400'
                },
                {
                  key: 'STORE',
                  label: 'STORE (Memory Write)',
                  min: 1,
                  max: 4,
                  desc: 'Store buffer commit latency',
                  color: 'accent-emerald-400'
                },
                {
                  key: 'ALU',
                  label: 'ADD / SUB (Simple ALU)',
                  min: 1,
                  max: 4,
                  desc: 'Single-cycle or multi-cycle arithmetic execution',
                  color: 'accent-amber-400'
                },
                {
                  key: 'DIV',
                  label: 'DIV (Integer Divide)',
                  min: 1,
                  max: 10,
                  desc: 'High-latency divider execution unit cycles',
                  color: 'accent-rose-400'
                },
                {
                  key: 'ANTI_PENALTY',
                  label: 'WAR / WAW Hazard Penalty',
                  min: 1,
                  max: 3,
                  desc: 'Minimum cycle separation for false register dependencies',
                  color: 'accent-purple-400'
                }
              ].map((param) => (
                <div key={param.key} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-200">{param.label}</span>
                    <span className="font-mono font-bold px-2 py-0.5 rounded bg-slate-950 border border-slate-800 text-cyan-300">
                      {latencies[param.key]} {latencies[param.key] === 1 ? 'cycle' : 'cycles'}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={param.min}
                    max={param.max}
                    value={latencies[param.key]}
                    onChange={(e) => handleLatencyChange(param.key, e.target.value)}
                    aria-label={param.label}
                    className={`w-full h-1.5 bg-slate-950 rounded-lg appearance-none cursor-pointer ${param.color}`}
                  />
                  <p className="text-[11px] text-slate-400">{param.desc}</p>
                </div>
              ))}
            </div>
          </div>

          {/* 3. Step-by-Step List Scheduling Algorithm & Trace */}
          <div className="rounded-2xl bg-slate-900/90 border border-slate-800/90 shadow-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between bg-slate-900/60">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-emerald-400" />
                <h2 className="text-sm font-semibold text-slate-100">
                  3. Step-by-Step Scheduling Algorithm
                </h2>
              </div>
              <div className="flex bg-slate-950 p-0.5 rounded-lg border border-slate-800 text-[11px]">
                <button
                  type="button"
                  onClick={() => setActiveAlgoStep('trace')}
                  className={`px-2 py-1 rounded-md font-medium transition-colors ${
                    activeAlgoStep === 'trace'
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Live Trace
                </button>
                <button
                  type="button"
                  onClick={() => setActiveAlgoStep('rules')}
                  className={`px-2 py-1 rounded-md font-medium transition-colors ${
                    activeAlgoStep === 'rules'
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Algorithm Rules
                </button>
              </div>
            </div>

            <div className="p-4">
              {activeAlgoStep === 'rules' ? (
                <div className="space-y-3 text-xs text-slate-300">
                  <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800">
                    <div className="font-semibold text-cyan-300 mb-1">
                      Step 1: Def-Use &amp; Hazard Graph Construction
                    </div>
                    <p className="text-slate-400 leading-relaxed">
                      Parse each instruction into <code className="text-cyan-200">Defs(i)</code> and{' '}
                      <code className="text-cyan-200">Uses(i)</code>. Add directed edges for{' '}
                      <span className="text-cyan-300 font-medium">RAW</span> (True data dependency, weight ={' '}
                      <code className="text-cyan-200">Latency(i)</code>),{' '}
                      <span className="text-amber-300 font-medium">WAR</span> (Anti-dependency), and{' '}
                      <span className="text-rose-300 font-medium">WAW</span> (Output dependency).
                    </p>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800">
                    <div className="font-semibold text-indigo-300 mb-1">
                      Step 2: Bottom-Up Critical Path Priority P(i)
                    </div>
                    <p className="text-slate-400 leading-relaxed font-mono text-[11px] bg-slate-900 p-2 rounded border border-slate-800 mb-1.5">
                      P(i) = max(Latency(i), max_j(Weight(i,j) + P(j)))
                    </p>
                    <p className="text-slate-400 leading-relaxed">
                      Computes the longest latency-weighted path from node <code className="text-indigo-200">i</code> to
                      the exit of the basic block. Instructions on the critical path receive the highest priority.
                    </p>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800">
                    <div className="font-semibold text-emerald-300 mb-1">
                      Step 3: Priority List Scheduling Heuristics
                    </div>
                    <p className="text-slate-400 leading-relaxed">
                      At each cycle <code className="text-emerald-200">t</code>, build the{' '}
                      <code className="text-emerald-200">Ready Pool</code> of instructions whose predecessors have
                      completed their required edge latency. Issue the candidate with the highest{' '}
                      <code className="text-emerald-200">P(i)</code>, tie-breaking by longest instruction latency and
                      earliest program order.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                  {analysis.algorithmTrace.map((step, idx) => (
                    <div
                      key={idx}
                      onClick={() => setScrubberCycle(step.cycle)}
                      className={`p-2.5 rounded-xl border text-xs cursor-pointer transition-all ${
                        scrubberCycle === step.cycle
                          ? 'bg-cyan-500/15 border-cyan-500/50'
                          : step.action === 'STALL'
                          ? 'bg-rose-950/20 border-rose-900/40 hover:border-rose-700/50'
                          : 'bg-slate-950/70 border-slate-800/80 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="font-mono font-bold text-slate-200">
                          Cycle {step.cycle}
                        </span>
                        <span
                          className={`text-[10px] font-mono px-2 py-0.5 rounded-full font-semibold ${
                            step.action === 'STALL'
                              ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                              : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                          }`}
                        >
                          {step.action === 'STALL' ? 'STALL BUBBLE' : `ISSUE ${step.chosenId}`}
                        </span>
                      </div>
                      <div className="font-mono text-[11px] text-cyan-200 mb-1">
                        {step.chosenText}
                      </div>
                      <div className="text-[11px] text-slate-400 leading-snug">
                        <span className="text-slate-500">Ready Pool:</span>{' '}
                        <span className="font-mono text-slate-300">{step.readyPool}</span> —{' '}
                        {step.rationale}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* RIGHT PANE: VISUAL DAG, LIVE CALCULATION TABLE, KPI CARDS & TIMELINE COMPARISON (8 Cols) */}
        <section className="lg:col-span-8 space-y-6">
          {/* Performance Metrics & KPI Cards Row */}
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
            <div className="rounded-2xl bg-slate-900/90 border border-slate-800 p-4 shadow-lg">
              <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                <span>Total Execution Cycles</span>
                <Clock className="w-4 h-4 text-cyan-400" />
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold font-mono text-white">
                  {analysis.metrics.optimizedTotalCycles}c
                </span>
                <span className="text-xs font-mono line-through text-slate-500">
                  {analysis.metrics.baselineTotalCycles}c base
                </span>
              </div>
              <div className="mt-2 flex items-center gap-1.5 text-[11px] text-emerald-400 font-medium">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Saved {analysis.metrics.cyclesSaved} clock cycles</span>
              </div>
            </div>

            <div className="rounded-2xl bg-slate-900/90 border border-slate-800 p-4 shadow-lg">
              <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                <span>Pipeline Stall Bubbles</span>
                <AlertTriangle className="w-4 h-4 text-rose-400" />
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold font-mono text-emerald-400">
                  {analysis.metrics.optimizedTotalStalls}
                </span>
                <span className="text-xs font-mono text-rose-400">
                  vs {analysis.metrics.baselineTotalStalls} stalls
                </span>
              </div>
              <div className="mt-2 text-[11px] text-slate-400">
                <span className="text-emerald-300 font-mono font-semibold">
                  {analysis.metrics.stallReductionPct}%
                </span>{' '}
                hazard stall reduction
              </div>
            </div>

            <div className="rounded-2xl bg-slate-900/90 border border-slate-800 p-4 shadow-lg">
              <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                <span>Schedule Speedup (S)</span>
                <TrendingUp className="w-4 h-4 text-emerald-400" />
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold font-mono text-cyan-300">
                  {analysis.metrics.speedup}x
                </span>
                <span className="text-[11px] font-mono text-slate-400">
                  T_base / T_opt
                </span>
              </div>
              <div className="mt-2 text-[11px] text-slate-400 font-mono">
                {analysis.metrics.baselineTotalCycles}c / {analysis.metrics.optimizedTotalCycles}c ={' '}
                {analysis.metrics.speedup}x
              </div>
            </div>

            <div className="rounded-2xl bg-slate-900/90 border border-slate-800 p-4 shadow-lg">
              <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                <span>Pipeline Utilization</span>
                <Activity className="w-4 h-4 text-indigo-400" />
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold font-mono text-indigo-300">
                  {analysis.metrics.optUtilization}%
                </span>
                <span className="text-xs font-mono text-slate-500">
                  from {analysis.metrics.baseUtilization}%
                </span>
              </div>
              <div className="mt-2 w-full bg-slate-950 h-1.5 rounded-full overflow-hidden border border-slate-800">
                <div
                  className="bg-gradient-to-r from-cyan-400 to-emerald-400 h-full transition-all duration-300"
                  style={{ width: `${Math.min(100, analysis.metrics.optUtilization)}%` }}
                />
              </div>
            </div>
          </div>

          {/* Interactive Insight Alert Banner */}
          <div className="rounded-xl bg-gradient-to-r from-cyan-950/40 via-slate-900 to-emerald-950/30 border border-cyan-500/30 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Zap className="w-4 h-4 text-cyan-400 shrink-0" />
              <p className="text-xs text-slate-200">
                {analysis.metrics.cyclesSaved > 0 ? (
                  <>
                    <span className="font-semibold text-cyan-300">Optimization Active:</span>{' '}
                    Reordering instructions by critical-path priority hid memory/ALU latency and eliminated{' '}
                    <span className="font-mono font-semibold text-emerald-300">
                      {analysis.metrics.baselineTotalStalls - analysis.metrics.optimizedTotalStalls}
                    </span>{' '}
                    pipeline stall bubble(s).
                  </>
                ) : (
                  <>
                    <span className="font-semibold text-amber-300">Serial Dependency Chain:</span>{' '}
                    Current instructions are strictly serialized or already optimal for these latency settings.
                  </>
                )}
              </p>
            </div>
            <span className="text-[11px] font-mono text-cyan-300 bg-cyan-500/10 px-2.5 py-1 rounded-md border border-cyan-500/20">
              Critical Path Bound: {analysis.maxPriority} Cycles
            </span>
          </div>

          {/* SECTION A: INTERACTIVE DATA DEPENDENCY DAG & LIVE PRIORITY CALCULATION TABLE */}
          {(activeRightTab === 'all' || activeRightTab === 'dag') && (
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
              {/* Interactive SVG Dependency Graph (7 Cols) */}
              <div className="xl:col-span-7 rounded-2xl bg-slate-900/90 border border-slate-800/90 shadow-xl overflow-hidden flex flex-col">
                <div className="px-4 py-3 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2 bg-slate-900/60">
                  <div className="flex items-center gap-2">
                    <GitBranch className="w-4 h-4 text-cyan-400" />
                    <h2 className="text-sm font-semibold text-slate-100">
                      Data Dependency Graph (DAG)
                    </h2>
                  </div>

                  {/* Hazard Type Filter Pills */}
                  <div className="flex items-center gap-1 text-[11px]">
                    {[
                      { id: 'ALL', label: `All (${analysis.edges.length})` },
                      {
                        id: 'RAW',
                        label: `RAW (${analysis.edges.filter((e) => e.type === 'RAW').length})`
                      },
                      {
                        id: 'WAR',
                        label: `WAR (${analysis.edges.filter((e) => e.type === 'WAR').length})`
                      },
                      {
                        id: 'WAW',
                        label: `WAW (${analysis.edges.filter((e) => e.type === 'WAW').length})`
                      }
                    ].map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => setHazardFilter(f.id)}
                        className={`px-2 py-0.5 rounded font-mono transition-colors ${
                          hazardFilter === f.id
                            ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                            : 'bg-slate-950 text-slate-400 hover:text-slate-200 border border-slate-800'
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* SVG Graph Canvas */}
                <div className="p-3 bg-slate-950/60 flex-1 flex flex-col justify-between overflow-x-auto">
                  <svg
                    viewBox={`0 0 ${dagLayout.width} ${dagLayout.height}`}
                    className="w-full h-auto min-h-[280px] select-none"
                  >
                    <defs>
                      <marker
                        id="arrow-raw"
                        markerWidth="8"
                        markerHeight="8"
                        refX="7"
                        refY="4"
                        orient="auto"
                      >
                        <path d="M0,0 L8,4 L0,8 Z" fill="#22d3ee" />
                      </marker>
                      <marker
                        id="arrow-war"
                        markerWidth="8"
                        markerHeight="8"
                        refX="7"
                        refY="4"
                        orient="auto"
                      >
                        <path d="M0,0 L8,4 L0,8 Z" fill="#f59e0b" />
                      </marker>
                      <marker
                        id="arrow-waw"
                        markerWidth="8"
                        markerHeight="8"
                        refX="7"
                        refY="4"
                        orient="auto"
                      >
                        <path d="M0,0 L8,4 L0,8 Z" fill="#f43f5e" />
                      </marker>
                    </defs>

                    {/* Render Directed Dependency Edges */}
                    {filteredEdges.map((edge) => {
                      const fromPos = dagLayout.nodeCoords.get(edge.from);
                      const toPos = dagLayout.nodeCoords.get(edge.to);
                      if (!fromPos || !toPos) return null;

                      const isHighlighted =
                        !activeHighlightId ||
                        activeHighlightId === edge.from ||
                        activeHighlightId === edge.to;

                      const startX = fromPos.x;
                      const startY = fromPos.y + 28;
                      const endX = toPos.x;
                      const endY = toPos.y - 30;
                      const midY = (startY + endY) / 2;
                      const curveOffset = startX === endX ? 28 : 0;
                      const pathD = `M ${startX} ${startY} C ${startX + curveOffset} ${midY}, ${
                        endX + curveOffset
                      } ${midY}, ${endX} ${endY}`;

                      const strokeColor =
                        edge.type === 'RAW'
                          ? '#22d3ee'
                          : edge.type === 'WAR'
                          ? '#f59e0b'
                          : '#f43f5e';
                      const markerUrl =
                        edge.type === 'RAW'
                          ? 'url(#arrow-raw)'
                          : edge.type === 'WAR'
                          ? 'url(#arrow-war)'
                          : 'url(#arrow-waw)';

                      const labelX = (startX + endX) / 2 + curveOffset * 0.7;
                      const labelY = midY;

                      return (
                        <g
                          key={edge.id}
                          style={{ opacity: isHighlighted ? 1 : 0.2, transition: 'opacity 200ms' }}
                        >
                          <path
                            d={pathD}
                            fill="none"
                            stroke={strokeColor}
                            strokeWidth={edge.type === 'RAW' ? 2.2 : 1.8}
                            strokeDasharray={
                              edge.type === 'WAR'
                                ? '5,4'
                                : edge.type === 'WAW'
                                ? '2,3'
                                : undefined
                            }
                            markerEnd={markerUrl}
                          />
                          <rect
                            x={labelX - 30}
                            y={labelY - 10}
                            width="60"
                            height="18"
                            rx="5"
                            fill="#0f172a"
                            stroke={strokeColor}
                            strokeWidth="1"
                          />
                          <text
                            x={labelX}
                            y={labelY + 2.5}
                            textAnchor="middle"
                            className="text-[10px] font-mono fill-slate-200"
                          >
                            {edge.register} (+{edge.weight}c)
                          </text>
                        </g>
                      );
                    })}

                    {/* Render Instruction DAG Nodes */}
                    {analysis.instructions.map((inst) => {
                      const pos = dagLayout.nodeCoords.get(inst.id);
                      if (!pos) return null;

                      const isSelected = activeHighlightId === inst.id;
                      const isConnected =
                        activeHighlightId &&
                        analysis.edges.some(
                          (e) =>
                            (e.from === activeHighlightId && e.to === inst.id) ||
                            (e.to === activeHighlightId && e.from === inst.id)
                        );
                      const dimmed = activeHighlightId && !isSelected && !isConnected;

                      const strokeColor = isSelected
                        ? '#22d3ee'
                        : inst.isCritical
                        ? '#f59e0b'
                        : '#334155';

                      return (
                        <g
                          key={inst.id}
                          transform={`translate(${pos.x}, ${pos.y})`}
                          onClick={() =>
                            setSelectedInstId(selectedInstId === inst.id ? null : inst.id)
                          }
                          onMouseEnter={() => setHoveredInstId(inst.id)}
                          onMouseLeave={() => setHoveredInstId(null)}
                          className="cursor-pointer"
                          style={{ opacity: dimmed ? 0.35 : 1, transition: 'opacity 200ms' }}
                        >
                          <rect
                            x="-78"
                            y="-28"
                            width="156"
                            height="56"
                            rx="12"
                            fill={isSelected ? '#083344' : '#0f172a'}
                            stroke={strokeColor}
                            strokeWidth={isSelected || inst.isCritical ? '2.2' : '1.5'}
                          />
                          {/* Node Header Pill */}
                          <text
                            x="-66"
                            y="-10"
                            className="text-[11px] font-mono font-bold fill-cyan-300"
                          >
                            {inst.id}: {inst.opcode}
                          </text>
                          <text
                            x="66"
                            y="-10"
                            textAnchor="end"
                            className={`text-[10px] font-mono font-semibold ${
                              inst.isCritical ? 'fill-amber-400' : 'fill-emerald-400'
                            }`}
                          >
                            P={inst.priority}
                          </text>
                          {/* Instruction Full Text */}
                          <text
                            x="0"
                            y="6"
                            textAnchor="middle"
                            className="text-[11px] font-mono fill-slate-200"
                          >
                            {inst.text.length > 20 ? `${inst.text.slice(0, 20)}` : inst.text}
                          </text>
                          {/* Sub-caption: Latency & Critical Badge */}
                          <text
                            x="-66"
                            y="21"
                            className="text-[9px] font-mono fill-slate-400"
                          >
                            Lat: {inst.latency}c
                          </text>
                          <text
                            x="66"
                            y="21"
                            textAnchor="end"
                            className="text-[9px] font-mono fill-slate-400"
                          >
                            {inst.isCritical ? 'CRITICAL PATH' : `Slack: ${inst.slack}c`}
                          </text>
                        </g>
                      );
                    })}
                  </svg>

                  {/* DAG Legend Footer */}
                  <div className="pt-2 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="flex items-center gap-1.5">
                        <span className="w-3 h-0.5 bg-cyan-400 inline-block" />
                        <span>RAW (True Data)</span>
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="w-3 h-0.5 bg-amber-400 inline-block border-b border-dashed" />
                        <span>WAR (Anti)</span>
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="w-3 h-0.5 bg-rose-400 inline-block" />
                        <span>WAW (Output)</span>
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="w-2.5 h-2.5 rounded-sm border border-amber-400 inline-block" />
                        <span>Critical Path Node</span>
                      </span>
                    </div>
                    <span className="text-slate-500">Click any node to lock highlight</span>
                  </div>
                </div>
              </div>

              {/* Live Calculation Table (5 Cols) */}
              <div className="xl:col-span-5 rounded-2xl bg-slate-900/90 border border-slate-800/90 shadow-xl overflow-hidden flex flex-col">
                <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between bg-slate-900/60">
                  <div className="flex items-center gap-2">
                    <Table2 className="w-4 h-4 text-amber-400" />
                    <h2 className="text-sm font-semibold text-slate-100">
                      Live Priority &amp; Hazard Table
                    </h2>
                  </div>
                  <span className="text-[11px] font-mono text-amber-300">
                    Dynamic Height P(i)
                  </span>
                </div>

                <div className="overflow-x-auto flex-1">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 bg-slate-950/60 text-[11px] font-mono uppercase text-slate-400">
                        <th className="py-2.5 px-3">ID</th>
                        <th className="py-2.5 px-3">Instruction</th>
                        <th className="py-2.5 px-2.5">Def / Use</th>
                        <th className="py-2.5 px-2.5 text-right">Lat</th>
                        <th className="py-2.5 px-3 text-right">Priority</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 font-mono">
                      {analysis.instructions.map((inst) => {
                        const isHighlighted = activeHighlightId === inst.id;
                        return (
                          <tr
                            key={inst.id}
                            onMouseEnter={() => setHoveredInstId(inst.id)}
                            onMouseLeave={() => setHoveredInstId(null)}
                            onClick={() =>
                              setSelectedInstId(selectedInstId === inst.id ? null : inst.id)
                            }
                            className={`cursor-pointer transition-colors ${
                              isHighlighted
                                ? 'bg-cyan-500/15'
                                : 'hover:bg-slate-800/50'
                            }`}
                          >
                            <td className="py-2.5 px-3 font-bold text-cyan-300">
                              {inst.id}
                            </td>
                            <td className="py-2.5 px-3 text-slate-200">
                              <div>{inst.text}</div>
                              <div className="text-[10px] text-slate-400">
                                {inst.outEdges.length > 0
                                  ? `-> ${inst.outEdges
                                      .map((e) => `${e.to}(${e.type})`)
                                      .join(', ')}`
                                  : 'Exit / Sink Node'}
                              </div>
                            </td>
                            <td className="py-2.5 px-2.5 text-[11px]">
                              <div className="text-emerald-300">
                                W: {inst.defs.join(',') || '-'}
                              </div>
                              <div className="text-indigo-300">
                                R: {inst.uses.join(',') || '-'}
                              </div>
                            </td>
                            <td className="py-2.5 px-2.5 text-right text-slate-300">
                              {inst.latency}c
                            </td>
                            <td className="py-2.5 px-3 text-right">
                              <span
                                className={`inline-flex items-center px-2 py-0.5 rounded font-bold text-xs ${
                                  inst.isCritical
                                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                                    : 'bg-slate-800 text-slate-200'
                                }`}
                              >
                                P={inst.priority}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Formula Footer */}
                <div className="p-3 bg-slate-950/80 border-t border-slate-800 text-[11px] text-slate-400 flex items-center justify-between">
                  <span>Critical Path Formula:</span>
                  <code className="text-cyan-300 font-mono">
                    P(i) = Lat(i) + max(Weight(i,j) + P(j))
                  </code>
                </div>
              </div>
            </div>
          )}

          {/* SECTION B: INTERACTIVE CYCLE SCRUBBER & PIPELINE PLAYBACK SIMULATOR */}
          {(activeRightTab === 'all' || activeRightTab === 'timeline') && (
            <div className="rounded-2xl bg-slate-900/90 border border-slate-800/90 shadow-xl p-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-cyan-400" />
                  <h2 className="text-sm font-semibold text-slate-100">
                    Interactive Cycle Scrubber &amp; Live State Inspector
                  </h2>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setScrubberCycle((c) => Math.max(1, c - 1))}
                    className="p-1.5 rounded-lg bg-slate-950 hover:bg-slate-800 border border-slate-800 text-slate-300"
                    title="Previous Cycle"
                    aria-label="Previous Cycle"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsPlaying((p) => !p)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs transition-colors"
                  >
                    {isPlaying ? (
                      <>
                        <Pause className="w-3.5 h-3.5" />
                        <span>Pause</span>
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5" />
                        <span>Simulate Cycles</span>
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setScrubberCycle((c) => Math.min(maxTimelineCycle, c + 1))}
                    className="p-1.5 rounded-lg bg-slate-950 hover:bg-slate-800 border border-slate-800 text-slate-300"
                    title="Next Cycle"
                    aria-label="Next Cycle"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                  <span className="font-mono text-xs px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-800 text-cyan-300">
                    Cycle {scrubberCycle} / {maxTimelineCycle}
                  </span>
                </div>
              </div>

              {/* Scrubber Slider */}
              <div className="space-y-2">
                <input
                  type="range"
                  min={1}
                  max={maxTimelineCycle}
                  value={scrubberCycle}
                  onChange={(e) => {
                    setIsPlaying(false);
                    setScrubberCycle(Number(e.target.value));
                  }}
                  aria-label="Cycle Scrubber"
                  className="w-full h-2 bg-slate-950 rounded-lg appearance-none cursor-pointer accent-cyan-400"
                />

                {/* Side-by-Side Live Cycle Status Cards */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
                  {/* Baseline status at cycle t */}
                  <div className="p-3 rounded-xl bg-slate-950/90 border border-slate-800 flex items-start justify-between gap-2">
                    <div>
                      <div className="text-[11px] font-mono uppercase text-slate-400">
                        Baseline Pipeline @ Cycle {scrubberCycle}
                      </div>
                      {baseAtScrubber.stallEntry ? (
                        <div className="mt-1 text-xs font-mono text-rose-400 font-semibold">
                          STALL BUBBLE — {baseAtScrubber.stallEntry.reason}
                        </div>
                      ) : baseAtScrubber.issueEntry ? (
                        <div className="mt-1 text-xs font-mono text-cyan-300 font-semibold">
                          ISSUING {baseAtScrubber.issueEntry.id}: {baseAtScrubber.issueEntry.text}
                        </div>
                      ) : scrubberCycle > analysis.metrics.baselineTotalCycles ? (
                        <div className="mt-1 text-xs font-mono text-slate-500">
                          Program Completed
                        </div>
                      ) : (
                        <div className="mt-1 text-xs font-mono text-slate-300">
                          Executing in-flight multi-cycle ops
                        </div>
                      )}
                    </div>
                    <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-300">
                      In-flight: {baseAtScrubber.activeInFlight.map((i) => i.id).join(', ') || 'None'}
                    </span>
                  </div>

                  {/* Optimized status at cycle t */}
                  <div className="p-3 rounded-xl bg-slate-950/90 border border-emerald-500/30 flex items-start justify-between gap-2">
                    <div>
                      <div className="text-[11px] font-mono uppercase text-emerald-400">
                        Optimized Pipeline @ Cycle {scrubberCycle}
                      </div>
                      {optAtScrubber.stallEntry ? (
                        <div className="mt-1 text-xs font-mono text-rose-400 font-semibold">
                          STALL BUBBLE — {optAtScrubber.stallEntry.reason}
                        </div>
                      ) : optAtScrubber.issueEntry ? (
                        <div className="mt-1 text-xs font-mono text-emerald-300 font-semibold">
                          ISSUING {optAtScrubber.issueEntry.id}: {optAtScrubber.issueEntry.text}
                        </div>
                      ) : scrubberCycle > analysis.metrics.optimizedTotalCycles ? (
                        <div className="mt-1 text-xs font-mono text-emerald-400 font-semibold">
                          Finished ({analysis.metrics.cyclesSaved}c ahead of Baseline!)
                        </div>
                      ) : (
                        <div className="mt-1 text-xs font-mono text-slate-300">
                          Completing tail latency in-flight
                        </div>
                      )}
                    </div>
                    <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-emerald-950/40 border border-emerald-500/30 text-emerald-300">
                      In-flight: {optAtScrubber.activeInFlight.map((i) => i.id).join(', ') || 'None'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* SECTION C: ORDERED OUTPUT & COMPARISON (BASELINE VS OPTIMIZED TABLES + GANTT TIMELINES) */}
          {(activeRightTab === 'all' || activeRightTab === 'timeline') && (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              {/* 1. BASELINE UNOPTIMIZED SCHEDULE CARD */}
              <div className="rounded-2xl bg-slate-900/90 border border-slate-800/90 shadow-xl overflow-hidden flex flex-col">
                <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between bg-slate-900/60">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                      <ShieldAlert className="w-4 h-4 text-rose-400" />
                      <span>Baseline Output (Unoptimized In-Order)</span>
                    </h3>
                    <p className="text-[11px] text-slate-400">
                      Original instruction sequence with {analysis.metrics.baselineTotalStalls} pipeline stall bubble(s)
                    </p>
                  </div>
                  <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-lg bg-rose-500/15 text-rose-300 border border-rose-500/30">
                    {analysis.metrics.baselineTotalCycles} Cycles
                  </span>
                </div>

                {/* Baseline Schedule Table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs font-mono">
                    <thead>
                      <tr className="border-b border-slate-800 bg-slate-950/60 text-[10px] uppercase text-slate-400">
                        <th className="py-2 px-3">#</th>
                        <th className="py-2 px-3">Instruction</th>
                        <th className="py-2 px-2.5 text-center">Issue</th>
                        <th className="py-2 px-2.5 text-center">Done</th>
                        <th className="py-2 px-3 text-right">Stalls</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {analysis.baselineSchedule.map((row) => (
                        <tr
                          key={row.id}
                          onMouseEnter={() => setHoveredInstId(row.id)}
                          onMouseLeave={() => setHoveredInstId(null)}
                          className={`transition-colors ${
                            activeHighlightId === row.id ? 'bg-cyan-500/15' : 'hover:bg-slate-800/40'
                          }`}
                        >
                          <td className="py-2 px-3 text-slate-400">
                            {row.order} ({row.id})
                          </td>
                          <td className="py-2 px-3 text-slate-200">
                            <div>{row.text}</div>
                            {row.stallsIncurred > 0 && (
                              <div className="text-[10px] text-rose-400">{row.stallReason}</div>
                            )}
                          </td>
                          <td className="py-2 px-2.5 text-center text-cyan-300">
                            C{row.issueCycle}
                          </td>
                          <td className="py-2 px-2.5 text-center text-slate-300">
                            C{row.completeCycle}
                          </td>
                          <td className="py-2 px-3 text-right">
                            {row.stallsIncurred > 0 ? (
                              <span className="px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30 text-[10px]">
                                +{row.stallsIncurred} STALL
                              </span>
                            ) : (
                              <span className="text-slate-500">0</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Baseline Gantt Cycle Timeline */}
                <div className="p-4 bg-slate-950/70 border-t border-slate-800 flex-1">
                  <div className="text-[11px] font-mono uppercase text-slate-400 mb-2 flex items-center justify-between">
                    <span>Baseline Pipeline Cycle Timeline</span>
                    <span>Red = Stall Bubble</span>
                  </div>
                  <div className="space-y-1.5 overflow-x-auto pb-1">
                    {/* Cycle Header Numbers */}
                    <div className="flex items-center gap-1 min-w-max">
                      <div className="w-16 text-[10px] font-mono text-slate-500">Cycle</div>
                      {Array.from({ length: maxTimelineCycle }, (_, i) => i + 1).map((c) => (
                        <div
                          key={c}
                          onClick={() => setScrubberCycle(c)}
                          className={`w-7 text-center text-[10px] font-mono rounded cursor-pointer ${
                            scrubberCycle === c
                              ? 'bg-cyan-500 text-slate-950 font-bold'
                              : 'text-slate-400 hover:bg-slate-800'
                          }`}
                        >
                          {c}
                        </div>
                      ))}
                    </div>

                    {/* Issue / Stall Track */}
                    <div className="flex items-center gap-1 min-w-max">
                      <div className="w-16 text-[10px] font-mono text-rose-300">Issue Slot</div>
                      {Array.from({ length: maxTimelineCycle }, (_, i) => i + 1).map((c) => {
                        const logItem = analysis.baselineCycleLog.find((l) => l.cycle === c);
                        return (
                          <div
                            key={c}
                            title={logItem ? `${logItem.instId}: ${logItem.reason}` : `Cycle ${c}`}
                            className={`w-7 h-6 rounded flex items-center justify-center text-[10px] font-mono font-bold border ${
                              logItem?.type === 'STALL'
                                ? 'bg-rose-500/30 border-rose-500/60 text-rose-200 animate-pulse'
                                : logItem?.type === 'ISSUE'
                                ? 'bg-cyan-500/25 border-cyan-500/50 text-cyan-200'
                                : 'bg-slate-900/60 border-slate-800/60 text-slate-600'
                            }`}
                          >
                            {logItem?.type === 'STALL'
                              ? 'XX'
                              : logItem?.type === 'ISSUE'
                              ? logItem.instId
                              : '·'}
                          </div>
                        );
                      })}
                    </div>

                    {/* Per-Instruction Execution Bars */}
                    {analysis.baselineSchedule.map((row) => (
                      <div key={row.id} className="flex items-center gap-1 min-w-max">
                        <div className="w-16 text-[10px] font-mono text-slate-400 truncate">
                          {row.id} ({row.opcode})
                        </div>
                        {Array.from({ length: maxTimelineCycle }, (_, i) => i + 1).map((c) => {
                          const isExecuting = c >= row.issueCycle && c <= row.completeCycle;
                          const isStallForThis =
                            c >= row.issueCycle - row.stallsIncurred && c < row.issueCycle;
                          return (
                            <div
                              key={c}
                              className={`w-7 h-5 rounded-sm flex items-center justify-center text-[9px] font-mono ${
                                isExecuting
                                  ? 'bg-indigo-500/40 border border-indigo-400/60 text-indigo-100'
                                  : isStallForThis
                                  ? 'bg-rose-500/20 border border-dashed border-rose-500/40 text-rose-300'
                                  : 'bg-slate-900/30'
                              }`}
                            >
                              {isExecuting ? 'EX' : isStallForThis ? 'ST' : ''}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* 2. OPTIMIZED PRIORITY SCHEDULE CARD */}
              <div className="rounded-2xl bg-slate-900/90 border border-emerald-500/30 shadow-xl overflow-hidden flex flex-col">
                <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between bg-emerald-950/20">
                  <div>
                    <h3 className="text-sm font-semibold text-emerald-200 flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      <span>Optimized Output (Priority List Scheduled)</span>
                    </h3>
                    <p className="text-[11px] text-slate-400">
                      Reordered by critical-path priority P(i) to hide instruction latency
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleCopySchedule}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-700 text-[11px] font-mono transition-colors"
                    >
                      {copiedCode ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                          <span className="text-emerald-300">Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5 text-slate-400" />
                          <span>Copy ASM</span>
                        </>
                      )}
                    </button>
                    <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-lg bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                      {analysis.metrics.optimizedTotalCycles} Cycles
                    </span>
                  </div>
                </div>

                {/* Optimized Schedule Table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs font-mono">
                    <thead>
                      <tr className="border-b border-slate-800 bg-slate-950/60 text-[10px] uppercase text-slate-400">
                        <th className="py-2 px-3">New #</th>
                        <th className="py-2 px-3">Instruction</th>
                        <th className="py-2 px-2 text-center">P(i)</th>
                        <th className="py-2 px-2.5 text-center">Issue</th>
                        <th className="py-2 px-2.5 text-center">Done</th>
                        <th className="py-2 px-3 text-right">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {analysis.optimizedSchedule.map((row) => (
                        <tr
                          key={row.id}
                          onMouseEnter={() => setHoveredInstId(row.id)}
                          onMouseLeave={() => setHoveredInstId(null)}
                          className={`transition-colors ${
                            activeHighlightId === row.id ? 'bg-cyan-500/15' : 'hover:bg-slate-800/40'
                          }`}
                        >
                          <td className="py-2 px-3 text-emerald-300 font-bold">
                            {row.order}{' '}
                            <span className="text-slate-500 font-normal">({row.id})</span>
                          </td>
                          <td className="py-2 px-3 text-slate-200">{row.text}</td>
                          <td className="py-2 px-2 text-center text-amber-300">
                            P={row.priority}
                          </td>
                          <td className="py-2 px-2.5 text-center text-emerald-300">
                            C{row.issueCycle}
                          </td>
                          <td className="py-2 px-2.5 text-center text-slate-300">
                            C{row.completeCycle}
                          </td>
                          <td className="py-2 px-3 text-right">
                            {row.movedUp ? (
                              <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[10px]">
                                HOISTED ↑
                              </span>
                            ) : row.stallsIncurred > 0 ? (
                              <span className="px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 text-[10px]">
                                +{row.stallsIncurred} STALL
                              </span>
                            ) : (
                              <span className="text-slate-400 text-[10px]">IN-ORDER</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Optimized Gantt Cycle Timeline */}
                <div className="p-4 bg-slate-950/70 border-t border-slate-800 flex-1">
                  <div className="text-[11px] font-mono uppercase text-emerald-400 mb-2 flex items-center justify-between">
                    <span>Optimized Pipeline Cycle Timeline</span>
                    <span>Saves {analysis.metrics.cyclesSaved} Cycles</span>
                  </div>
                  <div className="space-y-1.5 overflow-x-auto pb-1">
                    {/* Cycle Header Numbers */}
                    <div className="flex items-center gap-1 min-w-max">
                      <div className="w-16 text-[10px] font-mono text-slate-500">Cycle</div>
                      {Array.from({ length: maxTimelineCycle }, (_, i) => i + 1).map((c) => (
                        <div
                          key={c}
                          onClick={() => setScrubberCycle(c)}
                          className={`w-7 text-center text-[10px] font-mono rounded cursor-pointer ${
                            scrubberCycle === c
                              ? 'bg-emerald-400 text-slate-950 font-bold'
                              : c > analysis.metrics.optimizedTotalCycles
                              ? 'text-emerald-500/40 line-through'
                              : 'text-slate-400 hover:bg-slate-800'
                          }`}
                        >
                          {c}
                        </div>
                      ))}
                    </div>

                    {/* Issue / Stall Track */}
                    <div className="flex items-center gap-1 min-w-max">
                      <div className="w-16 text-[10px] font-mono text-emerald-300">Issue Slot</div>
                      {Array.from({ length: maxTimelineCycle }, (_, i) => i + 1).map((c) => {
                        const logItem = analysis.optimizedCycleLog.find((l) => l.cycle === c);
                        const isSavedZone = c > analysis.metrics.optimizedTotalCycles;
                        return (
                          <div
                            key={c}
                            title={
                              isSavedZone
                                ? `Cycle ${c}: Saved by optimization!`
                                : logItem
                                ? `${logItem.instId}: ${logItem.reason}`
                                : `Cycle ${c}`
                            }
                            className={`w-7 h-6 rounded flex items-center justify-center text-[10px] font-mono font-bold border ${
                              isSavedZone
                                ? 'bg-emerald-950/30 border-emerald-500/20 text-emerald-400'
                                : logItem?.type === 'STALL'
                                ? 'bg-rose-500/30 border-rose-500/60 text-rose-200'
                                : logItem?.type === 'ISSUE'
                                ? 'bg-emerald-500/25 border-emerald-500/50 text-emerald-200'
                                : 'bg-slate-900/60 border-slate-800/60 text-slate-600'
                            }`}
                          >
                            {isSavedZone
                              ? '✓'
                              : logItem?.type === 'STALL'
                              ? 'XX'
                              : logItem?.type === 'ISSUE'
                              ? logItem.instId
                              : '·'}
                          </div>
                        );
                      })}
                    </div>

                    {/* Per-Instruction Execution Bars */}
                    {analysis.optimizedSchedule.map((row) => (
                      <div key={row.id} className="flex items-center gap-1 min-w-max">
                        <div className="w-16 text-[10px] font-mono text-emerald-300 truncate">
                          {row.id} ({row.opcode})
                        </div>
                        {Array.from({ length: maxTimelineCycle }, (_, i) => i + 1).map((c) => {
                          const isExecuting = c >= row.issueCycle && c <= row.completeCycle;
                          return (
                            <div
                              key={c}
                              className={`w-7 h-5 rounded-sm flex items-center justify-center text-[9px] font-mono ${
                                isExecuting
                                  ? 'bg-emerald-500/40 border border-emerald-400/60 text-emerald-100'
                                  : 'bg-slate-900/30'
                              }`}
                            >
                              {isExecuting ? 'EX' : ''}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
