/**
 * Cleaning Roster Logic V3
 * Stream & Debt Model
 */

// --- Constants & Config ---
const CONFIG = {
    roles: [
        { id: 'nichoku', name: '日直', type: 'single', style: 'text-yellow-300' },
        { id: 'speech', name: 'スピーチ', type: 'single', style: 'text-green-300' },
        { id: 'comment', name: 'コメント', type: 'single', style: 'text-green-200' },
        { id: 'clean_a', name: '掃除A', type: 'clean', style: 'text-blue-300' },
        { id: 'clean_b', name: '掃除B', type: 'clean', style: 'text-blue-200' }
    ]
};

// --- State Management ---
class RosterState {
    constructor() {
        this.members = []; // { id: 1, name: "Name", active: true }
        this.pointers = {
            nichoku: 0,
            speech: 0,
            comment: 0,
            clean: 0 // Shared pointer for cleaning
        };
        this.startPointers = null; // Snapshot for simulation start
        this.debts = {}; // { MemberName: { nichoku: 0, clean: 0... } }
        this.settings = {
            startDate: new Date().toISOString(),
            daySettings: {} // { "2024-01-01": { isHoliday: true, ... } }
        };

        this.load();
    }

    load() {
        try {
            const saved = localStorage.getItem('roster_v3_state');
            if (saved) {
                const data = JSON.parse(saved);
                this.members = data.members || [];
                this.pointers = data.pointers || this.pointers;
                this.debts = data.debts || {};
                this.settings = data.settings || this.settings;
            }
        } catch (e) {
            console.error("Failed to load state", e);
        }
    }

    save() {
        const data = {
            members: this.members,
            pointers: this.pointers,
            debts: this.debts,
            settings: this.settings
        };
        localStorage.setItem('roster_v3_state', JSON.stringify(data));
    }

    reset() {
        localStorage.removeItem('roster_v3_state');
        location.reload();
    }
}

// --- Engine ---
class RosterEngine {
    constructor(state) {
        this.state = state;
    }

    get dateKey() {
        return (date) => date.toISOString().split('T')[0];
    }

    // Main Simulation
    simulate(days = 60) {
        const schedule = [];
        let currentDate = new Date(this.state.settings.startDate);

        // Simulation relies on temporary state clones
        // But to keep it simple and consistent with "Debt", we need to carry over debts day by day.
        // We will CLONE the current logic state to run the simulation without affecting real saved state.

        // Deep clone state for simulation
        let simPointers = { ...this.state.pointers };
        let simDebts = JSON.parse(JSON.stringify(this.state.debts));
        // Ensure all members have debt entries
        this.state.members.forEach(m => {
            if (!simDebts[m.name]) simDebts[m.name] = {};
        });

        for (let i = 0; i < days; i++) {
            const dKey = this.dateKey(currentDate);
            const daySettings = this.state.settings.daySettings[dKey] || {};

            // Check global holiday defaults (Sat/Sun)
            let isHoliday = daySettings.isHoliday;
            if (isHoliday === undefined) {
                const day = currentDate.getDay();
                isHoliday = (day === 0 || day === 6);
            }

            const dayResult = {
                date: new Date(currentDate),
                key: dKey,
                isHoliday,
                noCleaning: daySettings.noCleaning || false,
                manualAbsentees: daySettings.absentees || [], // Names of people marked absent MANUALLY for this day
                assignments: {}
            };

            if (!isHoliday) {
                // Determine available members for this day
                // (In a real app, you might have specific day-availability, here we assume active members - manual absentees)
                const availableMembers = this.state.members.filter(m =>
                    m.active && !dayResult.manualAbsentees.includes(m.name)
                );

                this.assignRolesForDay(dayResult, availableMembers, simPointers, simDebts);
            }

            schedule.push(dayResult);
            currentDate.setDate(currentDate.getDate() + 1);
        }

        return schedule;
    }

    assignRolesForDay(dayResult, availableMembers, pointers, debts) {
        const assignedNames = new Set(); // To check concurrency limits

        // Helper: Check Concurrency
        const canAssign = (member, roleId) => {
            if (assignedNames.has(member.name)) {
                // Rules:
                // 1. Cleaning vs Cleaning -> NO (But roleId is distinct, e.g. clean_a vs clean_b)
                //    We treat 'clean_a' and 'clean_b' as 'clean' type.

                // Get roles already assigned to this person today
                const currentRoles = Object.entries(dayResult.assignments)
                    .filter(([rId, name]) => name === member.name)
                    .map(([rId]) => rId);

                // Rule: Speech vs Comment -> NO
                if (roleId === 'speech' && currentRoles.includes('comment')) return false;
                if (roleId === 'comment' && currentRoles.includes('speech')) return false;

                // Rule: Cleaning vs Cleaning -> NO
                if (roleId.startsWith('clean') && currentRoles.some(r => r.startsWith('clean'))) return false;

                // Rule: Nichoku is OK with anything (except maybe itself, which is unique)
                // Rule: Cleaning is OK with Nichoku
                // Rule: Speech/Comment OK with Nichoku/Cleaning

                return true;
            }
            return true;
        };

        // Helper: Find Candidate
        const findCandidate = (roleId, pointerKey) => {
            // Strategy:
            // 1. Check Debts (High priority)
            // 2. Check Pointer (Normal rotation)

            // 1. Debt Check
            // We need a deterministic order for debts -> usually name or ID order
            const debtCandidates = availableMembers.filter(m => (debts[m.name]?.[pointerKey] || 0) > 0);

            // Sort debt candidates by amount of debt desc, then ID
            debtCandidates.sort((a, b) => {
                const da = debts[a.name][pointerKey];
                const db = debts[b.name][pointerKey];
                if (da !== db) return db - da;
                return a.studentNumber - b.studentNumber;
            });

            for (const m of debtCandidates) {
                if (canAssign(m, roleId)) {
                    // Assign from debt
                    debts[m.name][pointerKey]--;
                    return m;
                }
            }

            // 2. Pointer Check
            // We iterate through list starting from pointer
            // If the person at pointer is absent or busy, we SKIP them (and give them debt), and try next.
            // Wait, standard roster logic with "Debt":
            // "If turn comes but absent -> Add Debt, Move Pointer, Try Next."

            let attempts = 0;
            const totalMembers = this.state.members.length; // Active and Inactive? No, Pointer is index in Sorted Valid Member List usually?
            // User requirement: "Number setting". Usually implies fixed slots.
            // Let's assume Pointer is index in `this.state.members` (sorted by ID).

            // We loop until we find someone or exhaust list
            while (attempts < totalMembers) {
                const pIdx = pointers[pointerKey] % totalMembers;
                const candidate = this.state.members[pIdx];

                // If candidate is NOT ACTIVE (left school etc), just skip pointer?
                if (!candidate.active) {
                    pointers[pointerKey]++;
                    attempts++;
                    continue;
                }

                // If candidate is ACTIVE but ABSENT/BUSY today:
                if (!availableMembers.find(m => m.name === candidate.name)) {
                    // Absent -> Add Debt, Advance Pointer
                    if (!debts[candidate.name]) debts[candidate.name] = {};
                    debts[candidate.name][pointerKey] = (debts[candidate.name][pointerKey] || 0) + 1;

                    pointers[pointerKey]++;
                    attempts++;
                    continue;
                }

                if (!canAssign(candidate, roleId)) {
                    // Present but Busy (Conflict) -> Add Debt, Advance Pointer
                    // (Unless we want to wait? No, user said "priority to those with remaining count" implies we skip and debt)
                    if (!debts[candidate.name]) debts[candidate.name] = {};
                    debts[candidate.name][pointerKey] = (debts[candidate.name][pointerKey] || 0) + 1;

                    pointers[pointerKey]++;
                    attempts++;
                    continue;
                }

                // Found Valid Candidate
                pointers[pointerKey]++;
                return candidate;
            }
            return null; // No one available
        };

        // ASSIGNMENT SEQUENCE
        // We should assign in an order that respects difficulty? Or just fixed order.
        // Usually Cleaning requires most people.

        // Assignments:
        // 1. Nichoku (pointer: nichoku)
        // 2. Speech (pointer: speech)
        // 3. Comment (pointer: comment)
        // 4. Cleaning A (pointer: clean)
        // 5. Cleaning B (pointer: clean) -- Shares pointer with A

        // Nichoku
        const nichoku = findCandidate('nichoku', 'nichoku');
        if (nichoku) {
            dayResult.assignments['nichoku'] = nichoku.name;
            assignedNames.add(nichoku.name);
        }

        // Speech
        const speech = findCandidate('speech', 'speech');
        if (speech) {
            dayResult.assignments['speech'] = speech.name;
            assignedNames.add(speech.name);
        }

        // Comment
        const comment = findCandidate('comment', 'comment');
        if (comment) {
            dayResult.assignments['comment'] = comment.name;
            assignedNames.add(comment.name);
        }

        // Cleaning
        if (!dayResult.noCleaning) {
            // Sliding Window Logic:
            // We want overlapping pairs: (1, 2) -> (2, 3) -> (3, 4)
            // This means we should aim to effectively increment the pointer by just 1 each day,
            // even though we pick 2 people.

            // To achieve this robustly even with absences:
            // 1. Snapshot the current clean pointer.
            // 2. Find 2 candidates starting from that pointer.
            // 3. REGARDLESS of how many we searched or skipped, force the pointer to preserve the "slide by 1" intent?
            //    Actually, "next day starts with the 2nd person of today". 
            //    So if today is (P1, P2), tomorrow starts searching at P2? No, tomorrow should be (P2, P3).
            //    Today starts at ptr. Next day should start at ptr + 1.

            const startPtr = pointers['clean'];

            // Temporary separate pointers for searching to not mess up the "slide by 1" logic for next day
            // But we DO want to record debts if people are skipped.
            // So we can't just ignore the search process.

            // Let's use the standard search but MANUALLY reset the pointer for the next day.

            // Clean A
            const cleanA = findCandidate('clean_a', 'clean');
            if (cleanA) {
                dayResult.assignments['clean_a'] = cleanA.name;
                assignedNames.add(cleanA.name);
            }

            // Clean B
            const cleanB = findCandidate('clean_b', 'clean');
            if (cleanB) {
                dayResult.assignments['clean_b'] = cleanB.name;
                assignedNames.add(cleanB.name);
            }

            // Force Sliding Window:
            // The "findCandidate" method advances pointers['clean'] as it finds people.
            // However, to ensure the overlap (1,2 -> 2,3), we want the pointer for TOMORROW
            // to be exactly `startPtr + 1` (modulo count).
            // BUT: What if `startPtr` person was absent and skipped today?
            // If they were absent, they have debt. 
            // If we force `startPtr + 1`, we effectively move to the next person.

            // Original Request: "4, 5 do it, next day 5, 6 do it".
            // This implies a strict index progression.

            pointers['clean'] = startPtr + 1;
        }
    }
}

// --- UI Logic ---
const state = new RosterState();
const engine = new RosterEngine(state);

function init() {
    // Check if initial setup is needed
    if (state.members.length === 0) {
        showSetupModal();
    } else {
        renderApp();
    }
}

function renderApp() {
    renderConfig();
    renderSchedule();
    renderMemberList();
}

// --- Setup Modal ---
function showSetupModal() {
    const modal = document.getElementById('modal-overlay');
    const content = document.getElementById('modal-content');
    modal.classList.remove('hidden');
    content.innerHTML = `
        <h2 class="text-xl font-bold mb-4 text-white">初期設定</h2>
        <p class="text-gray-400 mb-4">メンバーの人数を入力してください。<br>(後で名前や人数の変更が可能です)</p>
        <input type="number" id="setup-count" value="20" min="1" class="w-full bg-gray-900 border border-gray-600 rounded p-2 text-white mb-4">
        <button onclick="submitSetup()" class="w-full bg-indigo-600 hover:bg-indigo-500 py-2 rounded text-white font-bold">開始する</button>
    `;
}

function submitSetup() {
    const count = parseInt(document.getElementById('setup-count').value);
    if (!count || count < 1) return;

    const newMembers = Array.from({ length: count }, (_, i) => ({
        studentNumber: i + 1,
        name: `生徒${i + 1}`,
        active: true
    }));

    state.members = newMembers;
    state.save();

    document.getElementById('modal-overlay').classList.add('hidden');
    renderApp();
}

// --- Main Schedule Render ---
function renderSchedule() {
    const tableBody = document.getElementById('schedule-body');
    if (!tableBody) return;
    tableBody.innerHTML = '';

    // Date navigation
    const currentMonthLabel = document.getElementById('current-month-display');
    if (currentMonthLabel && window.currentViewDate) {
        currentMonthLabel.innerText = `${window.currentViewDate.getFullYear()}年 ${(window.currentViewDate.getMonth() + 1)}月`;
    }

    // Run Simulation
    // We simulate enough days to cover the view
    // For simplicity, we restart simulation from 'startDate' every time.
    // In a production app with huge history, we might cache snapshopts.

    // Calculate days to display
    const viewDate = window.currentViewDate || new Date();
    const viewMonth = viewDate.getMonth();
    const viewYear = viewDate.getFullYear();

    const simStart = new Date(state.settings.startDate);
    const viewEnd = new Date(viewYear, viewMonth + 1, 0); // End of current view month

    const diffTime = viewEnd.getTime() - simStart.getTime();
    const daysToSimulate = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 5; // Buffer

    if (daysToSimulate < 0) {
        tableBody.innerHTML = `<tr><td colspan="8" class="text-center p-8 text-gray-500">設定された開始日より前です</td></tr>`;
        return;
    }

    const schedule = engine.simulate(daysToSimulate);

    // Filter for view
    const viewSchedule = schedule.filter(d =>
        d.date.getMonth() === viewMonth && d.date.getFullYear() === viewYear
    );

    viewSchedule.forEach(day => {
        const row = document.createElement('tr');
        const isToday = engine.dateKey(new Date()) === day.key;
        row.className = `border-b border-gray-800 hover:bg-white/5 transition group ${isToday ? 'bg-indigo-900/20' : ''} ${day.isHoliday ? 'bg-red-900/10' : ''}`;

        let html = `
            <td class="p-3 text-sm font-mono text-gray-400">${day.date.getDate()} (${['日', '月', '火', '水', '木', '金', '土'][day.date.getDay()]})</td>
            <td class="p-3 flex gap-1">
                 <button onclick="toggleHoliday('${day.key}')" class="p-1 text-xs rounded border ${day.isHoliday ? 'border-red-500 text-red-500' : 'border-gray-700 text-gray-500'} hover:border-red-400">休</button>
                 <button onclick="toggleNoCleaning('${day.key}')" class="p-1 text-xs rounded border ${day.noCleaning ? 'border-blue-500 text-blue-500' : 'border-gray-700 text-gray-500'} hover:border-blue-400">掃</button>
            </td>
        `;

        if (day.isHoliday) {
            html += `<td colspan="5" class="p-3 text-center text-red-400/50 text-sm tracking-widest">- HOLIDAY -</td>`;
        } else {
            // Roles
            CONFIG.roles.forEach(role => {
                const assignee = day.assignments[role.id];
                if (role.type === 'clean' && day.noCleaning) {
                    html += `<td class="p-3 text-gray-700 text-xs">-</td>`;
                } else if (assignee) {
                    html += `<td class="p-3 ${role.style} font-medium text-sm cursor-pointer hover:underline" onclick="toggleAbsent('${day.key}', '${assignee}')">${assignee}</td>`;
                } else {
                    html += `<td class="p-3 text-gray-700 text-xs">-</td>`;
                }
            });
        }

        // Absentees
        const absenteesHtml = day.manualAbsentees.map(name =>
            `<span class="inline-block bg-red-900/40 text-red-300 text-xs px-1 rounded border border-red-800/50 cursor-pointer hover:bg-red-800" onclick="toggleAbsent('${day.key}', '${name}')">${name}</span>`
        ).join(' ');

        html += `<td class="p-3 text-xs text-gray-500">${absenteesHtml}</td>`;

        row.innerHTML = html;
        tableBody.appendChild(row);
    });
}

// --- Actions ---

function toggleHoliday(dateKey) {
    if (!state.settings.daySettings[dateKey]) state.settings.daySettings[dateKey] = {};
    const ds = state.settings.daySettings[dateKey];
    ds.isHoliday = !ds.isHoliday;
    state.save();
    renderSchedule();
}

function toggleNoCleaning(dateKey) {
    if (!state.settings.daySettings[dateKey]) state.settings.daySettings[dateKey] = {};
    const ds = state.settings.daySettings[dateKey];
    ds.noCleaning = !ds.noCleaning;
    state.save();
    renderSchedule();
}

function toggleAbsent(dateKey, name) {
    if (!state.settings.daySettings[dateKey]) state.settings.daySettings[dateKey] = {};
    const ds = state.settings.daySettings[dateKey];
    if (!ds.absentees) ds.absentees = [];

    if (ds.absentees.includes(name)) {
        ds.absentees = ds.absentees.filter(n => n !== name);
    } else {
        ds.absentees.push(name);
    }
    state.save();
    renderSchedule();
}

// --- Member Management ---

function renderMemberList() {
    const tbody = document.getElementById('member-list-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    state.members.forEach(m => {
        const tr = document.createElement('tr');
        tr.className = "border-b border-gray-800";
        tr.innerHTML = `
            <td class="p-2 text-center text-gray-500">${m.studentNumber}</td>
            <td class="p-2"><input value="${m.name}" onchange="updateMemberName(${m.studentNumber}, this.value)" class="bg-transparent text-white border-b border-gray-700 focus:border-indigo-500 outline-none w-full"></td>
            <td class="p-2 text-center">
                <button onclick="toggleMemberActive(${m.studentNumber})" class="text-xs ${m.active ? 'text-green-400' : 'text-gray-600'}">${m.active ? '有効' : '無効'}</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function updateMemberName(num, newName) {
    const m = state.members.find(x => x.studentNumber === num);
    if (m) {
        // Need to migrate debts if name changes?
        // Yes, debts are keyed by Name.
        const oldName = m.name;
        if (state.debts[oldName]) {
            state.debts[newName] = state.debts[oldName];
            delete state.debts[oldName];
        }
        m.name = newName;
        state.save();
    }
}

function toggleMemberActive(num) {
    const m = state.members.find(x => x.studentNumber === num);
    if (m) {
        m.active = !m.active;
        state.save();
        renderMemberList(); // Re-render to show status
        renderSchedule(); // Re-calc schedule
    }
}

// --- Config / Pointers ---
function renderConfig() {
    // Allows manually setting the pointers
    // TODO: Add UI for this in index.html, then hook up here
    const container = document.getElementById('debug-pointers');
    if (!container) return;

    // Simple debug view
    container.innerHTML = `
        <div class="text-xs text-gray-500 font-mono">
            Nichoku: ${state.pointers.nichoku} <br>
            Speech: ${state.pointers.speech} <br>
            Comment: ${state.pointers.comment} <br>
            Clean: ${state.pointers.clean}
        </div>
    `;
}

// --- Global navigation ---
window.currentViewDate = new Date();
function changeMonth(delta) {
    window.currentViewDate.setMonth(window.currentViewDate.getMonth() + delta);
    renderSchedule();
}

function regenerateSchedule() {
    renderSchedule();
}

function resetAllData() {
    if (confirm('全てのデータを削除してリセットしますか？')) {
        state.reset();
    }
}

// --- Data Persistence ---
function exportData() {
    const data = JSON.stringify({
        members: state.members,
        pointers: state.pointers,
        debts: state.debts, // Debts are important to keep
        settings: state.settings
    }, null, 2);

    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `roster_v3_state_${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function importData(input) {
    const file = input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const data = JSON.parse(e.target.result);
            // Basic validation
            if (!data.members || !data.pointers) {
                throw new Error('Invalid format');
            }

            // Restore
            state.members = data.members;
            state.pointers = data.pointers;
            state.debts = data.debts || {};
            state.settings = data.settings || state.settings;
            state.save();

            alert('データを復元しました。ページをリロードします。');
            location.reload();
        } catch (err) {
            alert('ファイルの読み込みに失敗しました: ' + err.message);
        }
    };
    reader.readAsText(file);
}

// Init
window.addEventListener('DOMContentLoaded', init);
