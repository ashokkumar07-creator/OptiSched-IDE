# OptiSched IDE — Compiler Instruction DAG & Priority Scheduler

An interactive **Compiler Backend Instruction Scheduling & Pipeline Hazard Visualizer** built with **React, Vite, Tailwind CSS, and Lucide Icons**.

## Features
1. **User Input Module**:
   - Live editable assembly code editor (`LOAD`, `STORE`, `ADD`, `SUB`, `MUL`, `DIV`) with 4 pre-loaded benchmark kernels.
   - Real-time hardware latency sliders (`LOAD`, `MUL`, `STORE`, `ALU`, `DIV`, and `WAR/WAW` hazard penalty cycles).
2. **Live Processing & Logic**:
   - **Interactive SVG Data Dependency DAG**: Automatically detects and visualizes **RAW (True Data)**, **WAR (Anti)**, and **WAW (Output)** dependencies with exact latency weights.
   - **Live Priority Calculation Table**: Dynamically computes Def/Use register sets, instruction latencies, critical-path priority `P(i)`, and slack cycles.
   - **Step-by-Step List Scheduling Trace**: Shows the exact Ready Pool and tie-breaking rationale at every clock cycle.
3. **Ordered Output & Comparison**:
   - Side-by-side **Baseline (In-Order)** vs. **Optimized (Priority List Scheduled)** instruction tables and cycle-by-cycle Gantt execution timelines.
   - **KPI Performance Cards**: Total Execution Cycles, Pipeline Stall Reduction %, Speedup (`T_base / T_opt`), and CPU Pipeline Utilization %.
   - **Interactive Cycle Scrubber**: Play, pause, or scrub cycle-by-cycle to inspect live in-flight instructions and stall bubbles.

---

## How to Run in VS Code

### Prerequisites
- **Node.js** (v18+ recommended) installed from [nodejs.org](https://nodejs.org/)
- **Visual Studio Code (VS Code)**

### Step-by-Step Instructions
1. **Extract the ZIP Archive**:
   Unzip `compiler-instruction-scheduler-vscode.zip` to a folder on your computer.
2. **Open in VS Code**:
   - Launch **VS Code**.
   - Click **File -> Open Folder...** and select the extracted `compiler-instruction-scheduler` folder.
3. **Open the Integrated Terminal**:
   - Press `` Ctrl + ` `` (Windows/Linux) or `` Cmd + ` `` (macOS), or choose **Terminal -> New Terminal** from the top menu.
4. **Install Dependencies**:
   ```bash
   npm install
   ```
5. **Start the Development Server**:
   ```bash
   npm run dev
   ```
6. **View in Browser**:
   Vite will automatically open `http://localhost:5173` in your browser (or Ctrl+Click the URL shown in the terminal).
