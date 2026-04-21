import { useState, useEffect, useMemo, useRef } from "react";
import { Plus, Trash2, Copy, ChevronLeft, ChevronRight, Calendar, Check, Repeat, X, LogOut, RotateCcw } from "lucide-react";
import { supabase } from "./lib/supabase";
import { createStorage, migrateFromLocalStorage } from "./lib/storage";

const STORAGE_DATA_KEY = "reports:data";
const STORAGE_RECURRING_KEY = "reports:recurring";

function getMonday(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function parseDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

const DAY_NAMES_KR = ["일", "월", "화", "수", "목", "금", "토"];

function formatDateFull(dateStr) {
  const d = parseDate(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} (${DAY_NAMES_KR[d.getDay()]})`;
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

// Bullet utilities
function getBullet(depth) {
  return "•";
}

function parseLine(line) {
  const indentMatch = line.match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1] : "";
  const rest = line.substring(indent.length);
  const bulletMatch = rest.match(/^([-•○])\s(.*)$/);
  if (bulletMatch) {
    return { indent, bullet: bulletMatch[1], content: bulletMatch[2] };
  }
  return { indent, bullet: null, content: rest };
}

function formatLine(indent, content) {
  const depth = Math.floor(indent.length / 2);
  return indent + getBullet(depth) + " " + content;
}

function normalizeBullets(text) {
  if (!text) return "";
  return text
    .split("\n")
    .map(line => {
      const parsed = parseLine(line);
      if (!parsed.bullet) return line;
      return formatLine(parsed.indent, parsed.content);
    })
    .join("\n");
}

// Migrate from old format (arrays of items or "- " text) to new format (plain text with •/○)
function migrateData(rawData) {
  if (!rawData || typeof rawData !== "object") return {};
  const migrated = {};
  Object.entries(rawData).forEach(([date, day]) => {
    if (!day || typeof day !== "object") return;
    const newDay = {};
    ["done", "doing", "todo"].forEach(section => {
      let text = "";
      if (Array.isArray(day[section])) {
        text = day[section]
          .map(item => {
            const lines = [`- ${item.text}`];
            (item.children || []).forEach(c => lines.push(`  - ${c.text}`));
            return lines.join("\n");
          })
          .join("\n");
      } else if (typeof day[section] === "string") {
        text = day[section];
      }
      const normalized = normalizeBullets(text);
      // Only save sections that actually have content; leave empty sections
      // undefined so recurring items can auto-populate (see getSectionText)
      if (normalized.trim()) {
        newDay[section] = normalized;
      }
    });
    if (Object.keys(newDay).length > 0) {
      migrated[date] = newDay;
    }
  });
  return migrated;
}

// Derive section text: saved value if exists, otherwise auto-populate TODO with recurring items
function getSectionText(date, section, data, recurring) {
  if (data[date]?.[section] !== undefined) {
    return data[date][section];
  }
  if (section === "todo") {
    const weekday = parseDate(date).getDay();
    return recurring
      .filter(r => r.weekday === weekday)
      .map(r => `• ${r.text}`)
      .join("\n");
  }
  return "";
}

// Weekly report aggregation helpers: parse → merge by category → render with dates

function parseTree(text) {
  if (!text) return [];
  const root = { children: [] };
  const path = [root];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const indentLen = line.match(/^(\s*)/)[1].length;
    const depth = Math.floor(indentLen / 2);
    const content = line.substring(indentLen).replace(/^[•●○■\-]\s*/, "").trim();
    if (!content) continue;
    const node = { text: content, children: [] };
    while (path.length > depth + 1) path.pop();
    path[path.length - 1].children.push(node);
    path.push(node);
  }
  return root.children;
}

function treesMatch(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].text !== b[i].text) return false;
    if (!treesMatch(a[i].children, b[i].children)) return false;
  }
  return true;
}

function convertPlain(node) {
  return { text: node.text, dates: null, children: node.children.map(convertPlain) };
}

function mergeDaily(instances) {
  // instances: [{ date, children: [] }]
  const groups = new Map();
  for (const inst of instances) {
    for (const child of inst.children) {
      if (!groups.has(child.text)) groups.set(child.text, []);
      groups.get(child.text).push({ date: inst.date, children: child.children });
    }
  }
  const result = [];
  for (const [text, group] of groups) {
    const allMatch = group.every(g => treesMatch(g.children, group[0].children));
    if (allMatch) {
      const dates = [...new Set(group.map(g => g.date))].sort();
      result.push({ text, dates, children: group[0].children.map(convertPlain) });
    } else {
      result.push({ text, dates: null, children: mergeDaily(group) });
    }
  }
  return result;
}

function stripDates(nodes) {
  return nodes.map(n => ({ text: n.text, dates: null, children: stripDates(n.children) }));
}

function formatShortDate(dateStr) {
  const d = parseDate(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()} (${DAY_NAMES_KR[d.getDay()]})`;
}

function formatDateRange(dates) {
  if (!dates || !dates.length) return "";
  if (dates.length === 1) return formatShortDate(dates[0]);
  const parsed = dates.map(parseDate);
  let consecutive = true;
  for (let i = 1; i < parsed.length; i++) {
    const diff = Math.round((parsed[i] - parsed[i - 1]) / 86400000);
    if (diff !== 1) { consecutive = false; break; }
  }
  if (consecutive) {
    return formatShortDate(dates[0]) + " ~ " + formatShortDate(dates[dates.length - 1]);
  }
  return dates.map(formatShortDate).join(", ");
}

function renderWeeklyTree(nodes, depth = 0) {
  const lines = [];
  const indent = "  ".repeat(depth);
  const bullet = depth === 0 ? "●" : depth === 1 ? "○" : "■";
  for (const node of nodes) {
    let line = indent + bullet + " " + node.text;
    if (node.dates && node.dates.length) {
      line += " — " + formatDateRange(node.dates);
    }
    lines.push(line);
    if (node.children.length) {
      lines.push(...renderWeeklyTree(node.children, depth + 1));
    }
  }
  return lines;
}

async function copyToClipboard(text) {
  // Try modern Clipboard API first
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {
    // fall through to fallback
  }
  // Fallback: temporary textarea + execCommand (works in more restricted contexts)
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    ta.setAttribute("readonly", "");
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

export default function App() {
  const [session, setSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthLoading(false);
    });
    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => subscription.unsubscribe();
  }, []);

  if (authLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50">
        <div className="text-slate-400 text-sm">불러오는 중...</div>
      </div>
    );
  }
  if (!session) return <LoginPage />;
  return <ReportHelper session={session} />;
}

function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function signInWithGoogle() {
    setLoading(true);
    setError("");
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin }
    });
    if (error) {
      setError(error.message);
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <div className="max-w-sm w-full bg-white rounded-xl shadow-sm border border-slate-200 p-8 text-center">
        <div className="text-5xl mb-3">📝</div>
        <h1 className="text-xl font-bold text-slate-900 mb-2">업무보고툴</h1>
        <p className="text-sm text-slate-500 mb-6">Google 계정으로 로그인하여 시작하세요</p>
        <button
          onClick={signInWithGoogle}
          disabled={loading}
          className="w-full py-2.5 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
        >
          {loading ? "이동 중..." : "Google로 계속하기"}
        </button>
        {error && (
          <p className="text-xs text-red-600 mt-3 break-words">{error}</p>
        )}
        <p className="text-[11px] text-slate-400 mt-6 leading-relaxed">
          로그인하면 작성한 보고서가 클라우드에 저장되어 어느 기기에서든 이어서 쓸 수 있어요.
        </p>
      </div>
    </div>
  );
}

function ReportHelper({ session }) {
  const userId = session.user.id;
  const storage = useMemo(() => createStorage(userId), [userId]);

  const [data, setData] = useState({});
  const [recurring, setRecurring] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [weekStart, setWeekStart] = useState(getMonday(new Date()));
  const [toast, setToast] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showFullView, setShowFullView] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const result = await migrateFromLocalStorage(storage, userId);
        if (result.migrated) {
          setToast("이전 데이터를 클라우드로 옮겼어요");
          setTimeout(() => setToast(""), 2500);
        }
      } catch (e) {
        console.error("[migration]", e);
      }
      try {
        const d = await storage.get(STORAGE_DATA_KEY);
        if (d?.value) setData(migrateData(JSON.parse(d.value)));
      } catch {}
      try {
        const r = await storage.get(STORAGE_RECURRING_KEY);
        if (r?.value) setRecurring(JSON.parse(r.value));
      } catch {}
      setLoaded(true);
    })();
  }, [storage, userId]);

  useEffect(() => {
    if (!loaded) return;
    storage.set(STORAGE_DATA_KEY, JSON.stringify(data)).catch(() => {});
  }, [data, loaded, storage]);

  useEffect(() => {
    if (!loaded) return;
    storage.set(STORAGE_RECURRING_KEY, JSON.stringify(recurring)).catch(() => {});
  }, [recurring, loaded, storage]);

  async function signOut() {
    await supabase.auth.signOut();
  }

  const weekDates = useMemo(
    () => Array.from({ length: 5 }, (_, i) => formatDate(addDays(weekStart, i))),
    [weekStart]
  );

  function updateSection(date, section, newText) {
    setData(prev => {
      const current = prev[date] || {};
      return { ...prev, [date]: { ...current, [section]: newText } };
    });
  }

  function addRecurring(text, weekday) {
    if (!text.trim()) return;
    setRecurring(prev => [...prev, { id: uid(), text: text.trim(), weekday }]);
  }

  function deleteRecurring(id) {
    setRecurring(prev => prev.filter(r => r.id !== id));
  }

  function resetCurrentWeek() {
    setData(prev => {
      const next = { ...prev };
      weekDates.forEach(date => {
        delete next[date];
      });
      return next;
    });
    setShowResetConfirm(false);
    showToast("이번 주 내역 초기화됨");
  }

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(""), 2000);
  }

  async function copyDailyReport(date) {
    const sections = [
      { key: "done", label: "✅ DONE" },
      { key: "doing", label: "🔄 DOING" },
      { key: "todo", label: "📋 TODO" }
    ];
    const parts = [`📅 ${formatDateFull(date)} 업무보고`, ""];
    let hasContent = false;

    sections.forEach(s => {
      const text = normalizeBullets(getSectionText(date, s.key, data, recurring).trim());
      if (text) {
        hasContent = true;
        parts.push(s.label);
        parts.push(text);
        parts.push("");
      }
    });

    if (!hasContent) {
      showToast("입력된 항목이 없어요");
      return;
    }
    const ok = await copyToClipboard(parts.join("\n").trim());
    showToast(ok ? "일일 보고서 복사됨!" : "복사 실패 - 직접 복사해 주세요");
  }

  async function copyWeeklyReport() {
    const startStr = formatDate(weekStart);
    const endStr = formatDate(addDays(weekStart, 4));
    const parts = [`📊 주간 업무보고 (${startStr} ~ ${endStr})`, ""];

    const doneDays = [];
    const doingTodoDays = [];

    weekDates.forEach(date => {
      const doneText = getSectionText(date, "done", data, recurring).trim();
      if (doneText) {
        doneDays.push({ date, children: parseTree(doneText) });
      }
      const doingText = getSectionText(date, "doing", data, recurring).trim();
      const todoText = getSectionText(date, "todo", data, recurring).trim();
      const combined = [doingText, todoText].filter(Boolean).join("\n");
      if (combined) {
        doingTodoDays.push({ date, children: parseTree(combined) });
      }
    });

    if (!doneDays.length && !doingTodoDays.length) {
      showToast("이번 주 입력된 항목이 없어요");
      return;
    }

    if (doneDays.length) {
      const merged = mergeDaily(doneDays);
      if (merged.length) {
        parts.push("✅ DONE (이번 주 완료)");
        parts.push(...renderWeeklyTree(merged));
        parts.push("");
      }
    }

    if (doingTodoDays.length) {
      const merged = mergeDaily(doingTodoDays);
      const noDates = stripDates(merged);
      if (noDates.length) {
        parts.push("🔄 DOING ~ TODO (진행 중 / 이월)");
        parts.push(...renderWeeklyTree(noDates));
      }
    }

    const ok = await copyToClipboard(parts.join("\n").trim());
    showToast(ok ? "주간 보고서 복사됨!" : "복사 실패 - 직접 복사해 주세요");
  }

  function prevWeek() { setWeekStart(addDays(weekStart, -7)); }
  function nextWeek() { setWeekStart(addDays(weekStart, 7)); }
  function goThisWeek() { setWeekStart(getMonday(new Date())); }

  const today = formatDate(new Date());
  const isCurrentWeek = formatDate(weekStart) === formatDate(getMonday(new Date()));

  if (!loaded) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50">
        <div className="text-slate-400 text-sm">불러오는 중...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-6">
      <div className="max-w-7xl mx-auto">
        <div className="mb-5 flex items-start justify-between gap-2">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold text-slate-900">업무보고</h1>
            <p className="text-sm text-slate-500 mt-1">
              <span className="font-mono bg-slate-200/70 px-1 rounded">-</span> + 스페이스로 불릿,{" "}
              <span className="font-mono bg-slate-200/70 px-1 rounded">Tab</span>으로 하위 단계
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => setShowSettings(true)}
              className="flex items-center gap-1.5 px-3 py-2 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg text-sm text-slate-700 shadow-sm transition-colors"
            >
              <Repeat className="w-4 h-4" />
              <span className="hidden sm:inline">반복 설정</span>
              {recurring.length > 0 && (
                <span className="text-xs bg-slate-900 text-white px-1.5 py-0.5 rounded-full font-medium">
                  {recurring.length}
                </span>
              )}
            </button>
            <button
              onClick={signOut}
              className="flex items-center gap-1.5 px-3 py-2 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg text-sm text-slate-700 shadow-sm transition-colors"
              title={session.user.email ?? "로그아웃"}
            >
              <LogOut className="w-4 h-4" />
              <span className="hidden sm:inline">로그아웃</span>
            </button>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-3 mb-3 flex items-center justify-between">
          <button onClick={prevWeek} className="p-2 hover:bg-slate-100 rounded-lg transition-colors">
            <ChevronLeft className="w-4 h-4 text-slate-600" />
          </button>
          <div className="flex items-center gap-2 flex-wrap justify-center">
            <Calendar className="w-4 h-4 text-slate-400" />
            <span className="font-semibold text-slate-800 text-sm md:text-base">
              {formatDate(weekStart)} ~ {formatDate(addDays(weekStart, 4))}
            </span>
            {!isCurrentWeek ? (
              <button
                onClick={goThisWeek}
                className="text-xs px-2 py-1 bg-slate-900 hover:bg-slate-800 text-white rounded-md font-medium transition-colors"
              >
                이번 주로
              </button>
            ) : (
              <span className="text-xs px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full font-medium">이번 주</span>
            )}
          </div>
          <button onClick={nextWeek} className="p-2 hover:bg-slate-100 rounded-lg transition-colors">
            <ChevronRight className="w-4 h-4 text-slate-600" />
          </button>
        </div>

        <div className="mb-4 flex gap-2">
          <button
            onClick={copyWeeklyReport}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-sm font-medium shadow-sm transition-colors"
          >
            <Copy className="w-4 h-4" />
            <span className="hidden sm:inline">이번 주 전체 보고서 복사</span>
            <span className="sm:hidden">복사</span>
          </button>
          <button
            onClick={() => setShowFullView(true)}
            className="flex items-center justify-center gap-1.5 px-3 py-2.5 bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 rounded-lg text-sm font-medium shadow-sm transition-colors"
            title="이번주 전체보기"
          >
            이번주 전체보기
          </button>
          <button
            onClick={() => setShowResetConfirm(true)}
            className="flex items-center justify-center px-3 py-2.5 bg-white hover:bg-red-50 border border-slate-200 hover:border-red-200 text-slate-600 hover:text-red-600 rounded-lg text-sm font-medium shadow-sm transition-colors"
            title="이번 주 초기화"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <div className="flex divide-x divide-slate-200 min-w-max md:min-w-0">
              {weekDates.map(date => (
                <DayColumn
                  key={date}
                  date={date}
                  isToday={date === today}
                  getText={section => getSectionText(date, section, data, recurring)}
                  onTextChange={(section, text) => updateSection(date, section, text)}
                  onCopyDaily={() => copyDailyReport(date)}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="mt-5 text-center text-xs text-slate-400">
          자동 저장 · Enter로 다음 불릿, 빈 불릿에서 Enter로 목록 종료 · Shift+Tab으로 들여쓰기 취소
        </div>
      </div>

      {showSettings && (
        <RecurringModal
          recurring={recurring}
          onAdd={addRecurring}
          onDelete={deleteRecurring}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showResetConfirm && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
          onClick={() => setShowResetConfirm(false)}
        >
          <div
            className="bg-white rounded-xl shadow-xl max-w-sm w-full overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="p-5">
              <h2 className="font-bold text-slate-900 text-base mb-2">진짜 초기화할까요?</h2>
              <p className="text-sm text-slate-600 leading-relaxed">
                이번 주(<span className="font-medium text-slate-800">{formatDate(weekStart)} ~ {formatDate(addDays(weekStart, 4))}</span>)의{" "}
                DONE / DOING / TODO 내용이 모두 삭제됩니다. 복구할 수 없어요.
              </p>
            </div>
            <div className="px-5 pb-5 flex gap-2">
              <button
                onClick={() => setShowResetConfirm(false)}
                className="flex-1 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm font-medium transition-colors"
              >
                취소
              </button>
              <button
                onClick={resetCurrentWeek}
                className="flex-1 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium transition-colors"
              >
                초기화
              </button>
            </div>
          </div>
        </div>
      )}

      {showFullView && (
        <FullViewModal
          weekStart={weekStart}
          weekDates={weekDates}
          data={data}
          recurring={recurring}
          onClose={() => setShowFullView(false)}
        />
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium z-50 flex items-center gap-2">
          <Check className="w-4 h-4" />
          {toast}
        </div>
      )}
    </div>
  );
}

function DayColumn({ date, isToday, getText, onTextChange, onCopyDaily }) {
  const parsed = parseDate(date);

  const sections = [
    { key: "done", label: "DONE", color: "emerald" },
    { key: "doing", label: "DOING", color: "amber" },
    { key: "todo", label: "TODO", color: "blue" }
  ];

  return (
    <div className={`flex-1 min-w-[260px] flex flex-col ${isToday ? "bg-blue-50/30" : "bg-white"}`}>
      <div
        className={`px-3 py-2.5 border-b flex items-center justify-between ${
          isToday ? "bg-blue-50 border-blue-100" : "bg-slate-50/70 border-slate-100"
        }`}
      >
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-slate-500 font-medium">{DAY_NAMES_KR[parsed.getDay()]}</span>
          <span className={`text-sm font-bold ${isToday ? "text-blue-700" : "text-slate-700"}`}>
            {parsed.getMonth() + 1}/{parsed.getDate()}
          </span>
          {isToday && <span className="w-1.5 h-1.5 bg-blue-500 rounded-full ml-0.5"></span>}
        </div>
        <button
          onClick={onCopyDaily}
          className="p-1 hover:bg-white rounded text-slate-400 hover:text-slate-700 transition-colors"
          title="이 날의 보고서 복사"
        >
          <Copy className="w-3 h-3" />
        </button>
      </div>

      <div className="p-3 space-y-3.5 flex-1">
        {sections.map(s => (
          <SectionEditor
            key={s.key}
            section={s}
            value={getText(s.key)}
            onChange={text => onTextChange(s.key, text)}
          />
        ))}
      </div>
    </div>
  );
}

function SectionEditor({ section, value, onChange }) {
  const ref = useRef(null);
  const colorMap = {
    emerald: "bg-emerald-100 text-emerald-700",
    amber: "bg-amber-100 text-amber-700",
    blue: "bg-blue-100 text-blue-700"
  };

  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = "auto";
      ref.current.style.height = ref.current.scrollHeight + 2 + "px";
    }
  }, [value]);

  function setCursor(pos) {
    requestAnimationFrame(() => {
      if (ref.current) {
        ref.current.selectionStart = pos;
        ref.current.selectionEnd = pos;
      }
    });
  }

  function setSelection(start, end) {
    requestAnimationFrame(() => {
      if (ref.current) {
        ref.current.selectionStart = start;
        ref.current.selectionEnd = end;
      }
    });
  }

  const handleKeyDown = e => {
    // Skip during IME composition (Korean/Japanese/Chinese input)
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const ta = e.target;
    const v = ta.value;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;

    const lineStart = v.lastIndexOf("\n", start - 1) + 1;
    const lineEndIdx = v.indexOf("\n", start);
    const lineEnd = lineEndIdx === -1 ? v.length : lineEndIdx;
    const line = v.substring(lineStart, lineEnd);
    const lineBeforeCursor = v.substring(lineStart, start);

    if (e.key === "Tab") {
      e.preventDefault();
      const parsed = parseLine(line);

      if (e.shiftKey) {
        // Outdent: remove 2 spaces and update bullet if needed
        if (parsed.indent.length >= 2) {
          const newIndent = parsed.indent.substring(2);
          const newLine = parsed.bullet
            ? formatLine(newIndent, parsed.content)
            : newIndent + parsed.content;
          const newV = v.substring(0, lineStart) + newLine + v.substring(lineEnd);
          onChange(newV);
          setSelection(Math.max(start - 2, lineStart), Math.max(end - 2, lineStart));
        }
      } else {
        // Indent: add 2 spaces and update bullet if needed
        const newIndent = parsed.indent + "  ";
        const newLine = parsed.bullet
          ? formatLine(newIndent, parsed.content)
          : newIndent + parsed.content;
        const newV = v.substring(0, lineStart) + newLine + v.substring(lineEnd);
        onChange(newV);
        setSelection(start + 2, end + 2);
      }
      return;
    }

    if (e.key === "Enter") {
      const parsed = parseLine(lineBeforeCursor);
      if (parsed.bullet) {
        if (parsed.content.trim() === "") {
          // Empty bullet → exit list
          e.preventDefault();
          const newV = v.substring(0, lineStart) + v.substring(start);
          onChange(newV);
          setCursor(lineStart);
        } else {
          // Continue list with same-depth bullet
          e.preventDefault();
          const depth = Math.floor(parsed.indent.length / 2);
          const insertion = "\n" + parsed.indent + getBullet(depth) + " ";
          const newV = v.substring(0, start) + insertion + v.substring(end);
          onChange(newV);
          setCursor(start + insertion.length);
        }
      }
      return;
    }

    if (e.key === " ") {
      // Auto-convert "- " at line start to "• " or "○ " based on indent depth
      const match = lineBeforeCursor.match(/^(\s*)-$/);
      if (match) {
        e.preventDefault();
        const indent = match[1];
        const depth = Math.floor(indent.length / 2);
        const bullet = getBullet(depth);
        const newV = v.substring(0, lineStart) + indent + bullet + " " + v.substring(start);
        onChange(newV);
        setCursor(lineStart + indent.length + 2);
      }
      return;
    }

    if (e.key === "Backspace" && start === end) {
      // If cursor is right after a bullet marker ("• ", "○ ", "- "), remove just the bullet (keep indent)
      const match = lineBeforeCursor.match(/^(\s*)([-•○])\s$/);
      if (match) {
        e.preventDefault();
        const indent = match[1];
        const newV = v.substring(0, lineStart + indent.length) + v.substring(start);
        onChange(newV);
        setCursor(lineStart + indent.length);
      }
    }
  };

  return (
    <div>
      <div
        className={`inline-block text-[10px] font-bold px-1.5 py-0.5 rounded ${colorMap[section.color]} tracking-wider uppercase mb-1.5`}
      >
        {section.label}
      </div>
      <textarea
        ref={ref}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={"- 스페이스로 불릿\nTab으로 하위"}
        spellCheck={false}
        className="w-full resize-none px-1 py-0.5 text-xs text-slate-700 bg-transparent border-0 focus:outline-none placeholder:text-slate-300 placeholder:text-[11px] leading-relaxed hover:bg-slate-50/60 focus:bg-slate-50/40 rounded transition-colors"
        style={{
          fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Noto Sans KR', sans-serif",
          minHeight: "36px"
        }}
      />
    </div>
  );
}

function RecurringModal({ recurring, onAdd, onDelete, onClose }) {
  const [text, setText] = useState("");
  const [weekday, setWeekday] = useState(1);

  function handleAdd() {
    if (!text.trim()) return;
    onAdd(text, weekday);
    setText("");
  }

  const sortedRecurring = [...recurring].sort((a, b) => a.weekday - b.weekday);

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[85vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h2 className="font-bold text-slate-900">🔁 반복 업무 설정</h2>
            <p className="text-xs text-slate-500 mt-0.5">새 날짜의 TODO에 자동으로 미리 채워집니다</p>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded-lg">
            <X className="w-4 h-4 text-slate-500" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto flex-1">
          <div className="space-y-3 mb-5 pb-5 border-b border-slate-100">
            <input
              type="text"
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleAdd()}
              placeholder="예: 주간 팀 회의, 주보 작성..."
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-slate-400 focus:ring-1 focus:ring-slate-200"
            />
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-slate-500 flex-shrink-0">요일:</span>
              <div className="flex gap-1 flex-wrap">
                {[1, 2, 3, 4, 5].map(d => (
                  <button
                    key={d}
                    onClick={() => setWeekday(d)}
                    className={`w-9 h-9 text-sm font-semibold rounded-lg transition-colors ${
                      weekday === d
                        ? "bg-slate-900 text-white"
                        : "bg-slate-100 hover:bg-slate-200 text-slate-700"
                    }`}
                  >
                    {DAY_NAMES_KR[d]}
                  </button>
                ))}
              </div>
            </div>
            <button
              onClick={handleAdd}
              disabled={!text.trim()}
              className="w-full py-2 bg-slate-900 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium flex items-center justify-center gap-2 transition-colors"
            >
              <Plus className="w-4 h-4" />
              반복 업무 추가
            </button>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
              등록된 반복 업무 ({recurring.length})
            </div>
            {recurring.length === 0 ? (
              <div className="text-sm text-slate-400 text-center py-8">
                아직 등록된 반복 업무가 없어요
                <div className="text-xs mt-1">위에서 추가해보세요</div>
              </div>
            ) : (
              sortedRecurring.map(r => (
                <div
                  key={r.id}
                  className="flex items-center gap-2 p-2.5 bg-slate-50 rounded-lg hover:bg-slate-100 transition-colors"
                >
                  <span className="text-xs font-bold px-2 py-1 bg-white rounded-md border border-slate-200 text-slate-700 flex-shrink-0">
                    매주 {DAY_NAMES_KR[r.weekday]}
                  </span>
                  <span className="text-sm text-slate-700 flex-1 break-words">{r.text}</span>
                  <button
                    onClick={() => onDelete(r.id)}
                    className="p-1.5 hover:bg-red-50 rounded transition-colors flex-shrink-0"
                    title="삭제"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-slate-400 hover:text-red-500" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="px-5 py-3 border-t border-slate-100 bg-slate-50">
          <button
            onClick={onClose}
            className="w-full py-2 bg-white hover:bg-slate-100 border border-slate-200 text-slate-700 rounded-lg text-sm font-medium transition-colors"
          >
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}

function FullViewModal({ weekStart, weekDates, data, recurring, onClose }) {
  const doneDays = [];
  const doingTodoDays = [];

  weekDates.forEach(date => {
    const doneText = getSectionText(date, "done", data, recurring).trim();
    if (doneText) {
      doneDays.push({ date, children: parseTree(doneText) });
    }
    const doingText = getSectionText(date, "doing", data, recurring).trim();
    const todoText = getSectionText(date, "todo", data, recurring).trim();
    const combined = [doingText, todoText].filter(Boolean).join("\n");
    if (combined) {
      doingTodoDays.push({ date, children: parseTree(combined) });
    }
  });

  const mergedDone = doneDays.length ? mergeDaily(doneDays) : [];
  const mergedDoingTodo = doingTodoDays.length ? stripDates(mergeDaily(doingTodoDays)) : [];
  const hasAny = mergedDone.length > 0 || mergedDoingTodo.length > 0;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl max-w-3xl w-full max-h-[92vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between flex-shrink-0">
          <div>
            <h2 className="font-bold text-slate-900 text-lg">주간 업무보고</h2>
            <p className="text-sm text-slate-500 mt-0.5">
              {formatDate(weekStart)} ~ {formatDate(addDays(weekStart, 4))}
            </p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg transition-colors">
            <X className="w-4 h-4 text-slate-500" />
          </button>
        </div>

        <div className="p-6 md:p-8 overflow-y-auto flex-1">
          {!hasAny && (
            <div className="text-center text-slate-400 py-12">
              이번 주에 입력된 내용이 없어요
            </div>
          )}

          {mergedDone.length > 0 && (
            <div className="mb-8">
              <div className="inline-block text-sm font-bold px-2.5 py-1 bg-rose-100 text-rose-600 rounded mb-4 tracking-wider">
                DONE <span className="font-medium">(이번 주 완료)</span>
              </div>
              <TreeView nodes={mergedDone} />
            </div>
          )}

          {mergedDoingTodo.length > 0 && (
            <div>
              <div className="inline-block text-sm font-bold px-2.5 py-1 bg-rose-100 text-rose-600 rounded mb-4 tracking-wider">
                DOING ~ TODO <span className="font-medium">(진행 중 / 이월)</span>
              </div>
              <TreeView nodes={mergedDoingTodo} />
            </div>
          )}
        </div>

        <div className="px-6 py-3 border-t border-slate-100 bg-slate-50 flex-shrink-0">
          <button
            onClick={onClose}
            className="w-full py-2 bg-white hover:bg-slate-100 border border-slate-200 text-slate-700 rounded-lg text-sm font-medium transition-colors"
          >
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}

function TreeView({ nodes, depth = 0 }) {
  const bullets = ["●", "○", "■"];
  const bullet = bullets[Math.min(depth, bullets.length - 1)];
  const textClasses = [
    "font-bold text-slate-900 text-base",
    "text-slate-800 text-sm",
    "text-slate-600 text-sm"
  ];
  const textClass = textClasses[Math.min(depth, textClasses.length - 1)];
  const spacingClass = depth === 0 ? "space-y-2" : "space-y-1 mt-1";

  return (
    <div className={spacingClass} style={{ paddingLeft: depth === 0 ? 0 : "1.5rem" }}>
      {nodes.map((node, i) => (
        <div key={i}>
          <div className="flex items-start gap-2">
            <span className={`${textClass} flex-shrink-0 leading-relaxed`} style={{ minWidth: "14px" }}>
              {bullet}
            </span>
            <div className={`${textClass} flex-1 leading-relaxed break-words`}>
              {node.text}
              {node.dates && node.dates.length > 0 && (
                <span className="ml-2 text-xs font-semibold text-slate-500">
                  — {formatDateRange(node.dates)}
                </span>
              )}
            </div>
          </div>
          {node.children.length > 0 && (
            <TreeView nodes={node.children} depth={depth + 1} />
          )}
        </div>
      ))}
    </div>
  );
}
