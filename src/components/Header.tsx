import React, { useState, useEffect, useRef } from 'react';
import {
  Shield,
  Radio,
  Users,
  MessageSquareQuote,
  BarChart3,
  FileText,
  CheckCircle2,
  Key,
  X,
  Activity,
  AlertCircle,
  Sun,
  Moon,
  ChevronDown,
} from 'lucide-react';
import type { CurationTeam } from '../types';
import { loginWithKeychain } from '../lib/keychain';
import { OLO_CURATION_HUB_LOGO } from '../lib/constants';

interface HeaderProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  currentUser: string | null;
  currentTeam: CurationTeam | null;
  teamAccounts: CurationTeam[];
  onLogin: (username: string) => void;
  onLogout: () => void;
  theme?: 'dark' | 'light';
  toggleTheme?: () => void;
  queueCount?: number;
  guidanceCount?: number;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  setActiveTab,
  currentUser,
  currentTeam,
  teamAccounts,
  onLogin,
  onLogout,
  theme = 'dark',
  toggleTheme,
  queueCount = 0,
  guidanceCount = 0,
}) => {
  const [loginInput, setLoginInput] = useState('');
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [showVpDrawer, setShowVpDrawer] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const vpDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showVpDrawer) setShowVpDrawer(false);
        if (showLoginModal && !verifying) {
          setShowLoginModal(false);
          setLoginError(null);
        }
      }
    };
    const handleClickOutside = (e: MouseEvent) => {
      if (vpDropdownRef.current && !vpDropdownRef.current.contains(e.target as Node)) {
        setShowVpDrawer(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('mousedown', handleClickOutside);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showLoginModal, showVpDrawer, verifying]);

  const tabs = [
    { id: 'radar', label: 'Radar', icon: Radio },
    { id: 'rescue', label: 'Rescue', icon: Shield },
    { id: 'claims', label: 'Queue', icon: Users },
    { id: 'mentorship', label: 'Guidance', icon: MessageSquareQuote },
    { id: 'intelligence', label: 'Intelligence', icon: BarChart3 },
    { id: 'report', label: 'Report', icon: FileText },
  ];

  const avgVp =
    teamAccounts.length > 0
      ? Math.round(
          teamAccounts.reduce((acc, t) => acc + t.currentVP, 0) / teamAccounts.length
        )
      : null;

  const vpSummaryValue = currentTeam ? currentTeam.currentVP : avgVp;
  const vpSummaryLabel = currentTeam ? `@${currentTeam.account}` : 'Curator VP';

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanUsername = loginInput.trim().toLowerCase().replace(/^@/, '');
    if (!cleanUsername) return;

    setVerifying(true);
    setLoginError(null);
    const res = await loginWithKeychain(cleanUsername);
    setVerifying(false);

    if (res.success) {
      onLogin(cleanUsername);
      setShowLoginModal(false);
      setLoginInput('');
    } else {
      setLoginError(res.error || 'Keychain verification failed.');
    }
  };

  const isDark = theme === 'dark';

  return (
    <header
      className={`sticky top-0 z-40 border-b backdrop-blur-xl ${
        isDark
          ? 'bg-slate-950/90 border-slate-800/80 shadow-[0_4px_20px_rgba(0,0,0,0.45)]'
          : 'bg-white/90 border-slate-200 shadow-sm'
      }`}
    >
      {/* Compact Single-Row Bar */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center justify-between gap-3">
        {/* Brand Logo */}
        <button
          type="button"
          onClick={() => setActiveTab('radar')}
          className="flex items-center shrink-0 focus:outline-none focus:ring-2 focus:ring-teal-500/50 rounded-lg transition-transform active:scale-95"
          title="Olo Curation Hub — Home"
          aria-label="Olo Curation Hub Home"
        >
          <img
            src={OLO_CURATION_HUB_LOGO}
            alt="Olo Curation Hub"
            className="h-9 sm:h-10 w-auto object-contain"
          />
        </button>

        {/* Inline Desktop Navigation */}
        <nav
          aria-label="Primary"
          className="hidden lg:flex items-center gap-1 overflow-x-auto scrollbar-none"
        >
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                  isActive
                    ? isDark
                      ? 'bg-teal-500/15 text-teal-300 border border-teal-500/30'
                      : 'bg-teal-50 text-teal-700 border border-teal-200'
                    : isDark
                    ? 'text-slate-300 hover:text-white hover:bg-slate-800/70 border border-transparent'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100 border border-transparent'
                }`}
              >
                <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-teal-400' : 'text-slate-400'}`} />
                <span>{tab.label}</span>
                {tab.id === 'claims' && queueCount > 0 && (
                  <span className="ml-1 px-1.5 py-0.2 rounded-full text-[10px] font-bold font-mono bg-teal-500/20 text-teal-700 dark:bg-teal-500/30 dark:text-teal-300">
                    {queueCount}
                  </span>
                )}
                {tab.id === 'mentorship' && guidanceCount > 0 && (
                  <span className="ml-1 px-1.5 py-0.2 rounded-full text-[10px] font-bold font-mono bg-amber-500/20 text-amber-700 dark:bg-amber-500/30 dark:text-amber-300">
                    {guidanceCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Right Controls: VP Dropdown + Theme + Auth */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Expandable Curator VP Popover (Zero Clipping) */}
          <div className="relative" ref={vpDropdownRef}>
            <button
              onClick={() => setShowVpDrawer((prev) => !prev)}
              aria-expanded={showVpDrawer}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-mono transition-colors ${
                isDark
                  ? 'bg-slate-900 border-slate-700/80 text-slate-200 hover:border-slate-600'
                  : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
              }`}
              title="Inspect live Voting Power for all 11 curation accounts"
            >
              <Activity className="w-3.5 h-3.5 text-teal-400" />
              <span className="hidden md:inline text-slate-400">{vpSummaryLabel}:</span>
              <span
                className={`font-bold tabular-nums ${
                  vpSummaryValue === null
                    ? 'text-slate-400'
                    : vpSummaryValue >= 85
                    ? 'text-emerald-400'
                    : vpSummaryValue >= 70
                    ? 'text-amber-400'
                    : 'text-rose-400'
                }`}
              >
                {vpSummaryValue !== null ? `${vpSummaryValue}%` : '…'}
              </span>
              <ChevronDown
                className={`w-3.5 h-3.5 text-slate-400 transition-transform ${
                  showVpDrawer ? 'rotate-180' : ''
                }`}
              />
            </button>

            {showVpDrawer && (
              <div
                className={`absolute right-0 mt-2 w-[340px] sm:w-[460px] rounded-2xl border p-4 shadow-2xl z-50 ${
                  isDark
                    ? 'bg-slate-900 border-slate-700/90 text-slate-100'
                    : 'bg-white border-slate-200 text-slate-900'
                }`}
              >
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-bold flex items-center gap-1.5">
                    <Activity className="w-3.5 h-3.5 text-teal-400" />
                    Official Curation Accounts VP ({teamAccounts.length})
                  </span>
                  <span className="text-[11px] font-mono text-slate-400">
                    100% Vote Value (STU)
                  </span>
                </div>

                {teamAccounts.length === 0 ? (
                  <p className="text-xs text-slate-400 font-mono py-4 text-center">
                    Syncing curation accounts from Steem RPC…
                  </p>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {teamAccounts.map((t) => {
                      const vpColor =
                        t.currentVP >= 85
                          ? 'text-emerald-400'
                          : t.currentVP >= 70
                          ? 'text-amber-400'
                          : 'text-rose-400';
                      const barColor =
                        t.currentVP >= 85
                          ? 'bg-emerald-500'
                          : t.currentVP >= 70
                          ? 'bg-amber-500'
                          : 'bg-rose-500';
                      return (
                        <div
                          key={t.id}
                          className={`p-2 rounded-xl border text-[11px] font-mono ${
                            isDark
                              ? 'bg-slate-950/90 border-slate-800'
                              : 'bg-slate-50 border-slate-200'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-1">
                            <span className="truncate font-semibold text-slate-300 dark:text-slate-200">
                              @{t.account}
                            </span>
                            <span className={`font-bold tabular-nums ${vpColor}`}>
                              {t.currentVP}%
                            </span>
                          </div>
                          <div className="w-full h-1 rounded-full bg-slate-800/70 my-1.5 overflow-hidden">
                            <div
                              className={`h-full rounded-full ${barColor}`}
                              style={{ width: `${Math.min(100, Math.max(0, t.currentVP))}%` }}
                            />
                          </div>
                          <div className="flex items-center justify-between text-[10px] text-slate-400">
                            <span>{t.name}</span>
                            <span className="tabular-nums">${t.voteValue100.toFixed(2)}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Theme Toggle */}
          {toggleTheme && (
            <button
              onClick={toggleTheme}
              className={`p-2 rounded-lg border transition-colors ${
                isDark
                  ? 'bg-slate-900 border-slate-700/80 text-slate-300 hover:bg-slate-800'
                  : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-100'
              }`}
              title="Toggle Theme"
              aria-label="Toggle Theme"
            >
              {isDark ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
            </button>
          )}

          {/* Auth Control */}
          {currentUser ? (
            <div
              className={`flex items-center gap-2 border px-2.5 py-1 rounded-lg ${
                isDark ? 'bg-slate-900 border-slate-700/80' : 'bg-white border-slate-200'
              }`}
            >
              <div className="flex flex-col text-right leading-tight">
                <span
                  className={`text-xs font-semibold flex items-center gap-1 justify-end ${
                    isDark ? 'text-white' : 'text-slate-900'
                  }`}
                >
                  <CheckCircle2 className="w-3 h-3 text-emerald-400" />@{currentUser}
                </span>
                <span className="text-[10px] font-mono text-teal-400">
                  {currentTeam ? currentTeam.name : 'Observer'}
                </span>
              </div>
              <button
                onClick={onLogout}
                className="text-[11px] text-slate-400 hover:text-rose-400 transition-colors pl-1"
                title="Disconnect Account"
              >
                Out
              </button>
            </div>
          ) : (
            <button
              onClick={() => {
                setLoginError(null);
                setShowLoginModal(true);
              }}
              className="tactile-button flex items-center gap-1.5 bg-teal-600 hover:bg-teal-500 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
            >
              <Key className="w-3.5 h-3.5" />
              <span>Keychain</span>
            </button>
          )}
        </div>
      </div>

      {/* Compact Mobile/Tablet Tab Bar (Only shown below lg breakpoint) */}
      <div
        className={`lg:hidden border-t px-3 py-1.5 overflow-x-auto scrollbar-none ${
          isDark ? 'border-slate-800/80' : 'border-slate-200'
        }`}
      >
        <nav className="flex items-center gap-1">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap ${
                  isActive
                    ? isDark
                      ? 'bg-teal-500/15 text-teal-300 border border-teal-500/30'
                      : 'bg-teal-50 text-teal-700 border border-teal-200'
                    : isDark
                    ? 'text-slate-300 hover:bg-slate-800/70'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{tab.label}</span>
                {tab.id === 'claims' && queueCount > 0 && (
                  <span className="ml-1 px-1.5 py-0.2 rounded-full text-[10px] font-bold font-mono bg-teal-500/20 text-teal-700 dark:bg-teal-500/30 dark:text-teal-300">
                    {queueCount}
                  </span>
                )}
                {tab.id === 'mentorship' && guidanceCount > 0 && (
                  <span className="ml-1 px-1.5 py-0.2 rounded-full text-[10px] font-bold font-mono bg-amber-500/20 text-amber-700 dark:bg-amber-500/30 dark:text-amber-300">
                    {guidanceCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Keychain Sign-In Modal */}
      {showLoginModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div
            className={`rounded-2xl max-w-sm w-full p-6 shadow-2xl relative border ${
              isDark
                ? 'tactile-card border-slate-700 text-white'
                : 'bg-white border-slate-200 text-slate-900'
            }`}
          >
            <button
              onClick={() => !verifying && setShowLoginModal(false)}
              className="absolute right-4 top-4 text-slate-400 hover:text-white"
              aria-label="Close login modal"
            >
              <X className="w-4 h-4" />
            </button>
            <div className="flex items-center gap-2 mb-2">
              <Key className="w-4 h-4 text-teal-400" />
              <h3 className="text-base font-bold tracking-tight">Curator Sign In</h3>
            </div>
            <p className="text-xs text-slate-400 mb-4 [text-wrap:pretty]">
              Enter your Steem username. A posting-key buffer signature is verified via Steem Keychain with zero private key exposure.
            </p>
            {loginError && (
              <div className="mb-3 p-2.5 rounded-xl bg-rose-950/80 border border-rose-800/70 text-rose-300 text-xs flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{loginError}</span>
              </div>
            )}
            <form onSubmit={handleLoginSubmit} className="space-y-4">
              <div>
                <label className="text-xs font-medium text-slate-300 block mb-1">
                  Steem Account
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-2.5 text-slate-400 text-xs font-mono">
                    @
                  </span>
                  <input
                    type="text"
                    value={loginInput}
                    onChange={(e) => setLoginInput(e.target.value)}
                    placeholder="e.g. adeljose or weisser-rabe"
                    disabled={verifying}
                    className={`w-full border rounded-xl pl-8 pr-3 py-2 text-xs focus:outline-none focus:border-teal-500 font-mono ${
                      isDark
                        ? 'bg-slate-950 border-slate-700 text-white'
                        : 'bg-slate-50 border-slate-200 text-slate-900'
                    }`}
                    autoFocus
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  disabled={verifying}
                  onClick={() => setShowLoginModal(false)}
                  className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={verifying || !loginInput.trim()}
                  className="tactile-button px-4 py-1.5 bg-teal-600 hover:bg-teal-500 disabled:opacity-50 text-white font-medium text-xs rounded-xl"
                >
                  {verifying ? 'Verifying…' : 'Sign with Keychain'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </header>
  );
};
