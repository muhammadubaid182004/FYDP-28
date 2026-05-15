import { useLocation, Link } from "wouter";
import { useApp } from "@/context/AppContext";
import { Activity, LayoutDashboard, ScanEye, LogOut, ChevronRight, User } from "lucide-react";

interface LayoutProps {
  children: React.ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const [location, setLocation] = useLocation();
  const { user, logout, underReview } = useApp();

  const handleLogout = () => {
    logout();
    setLocation("/");
  };

  const navItems = [
    { path: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { path: "/inference", label: "Inference", icon: ScanEye, badge: underReview.length },
  ];

  return (
    <div className="min-h-screen bg-[#070d1a] flex">
      <aside
        className="
          group/sidebar
          bg-[#0a1628] border-r border-slate-800/60
          flex flex-col fixed h-full z-20
          w-[68px] hover:w-64
          transition-[width] duration-300 ease-in-out
          overflow-hidden
        "
      >
        {/* Logo */}
        <div className="p-4 border-b border-slate-800/60 flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center shadow-lg shadow-cyan-500/20 flex-shrink-0">
              <Activity className="w-5 h-5 text-white" />
            </div>
            <div className="opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200 delay-100 whitespace-nowrap overflow-hidden">
              <h1 className="text-white font-bold text-base leading-tight">RetinaScan AI</h1>
              <p className="text-slate-500 text-xs">DR Detection System</p>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-3 space-y-1">
          {navItems.map(({ path, label, icon: Icon, badge }) => {
            const active = location === path;
            return (
              <Link key={path} href={path}>
                <div
                  title={label}
                  className={`flex items-center justify-between px-3 py-3 rounded-xl cursor-pointer transition-all duration-200 group/item ${
                    active
                      ? "bg-gradient-to-r from-cyan-500/20 to-blue-600/10 border border-cyan-500/20 text-cyan-400"
                      : "text-slate-400 hover:bg-slate-800/50 hover:text-white"
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Icon className={`w-5 h-5 flex-shrink-0 ${active ? "text-cyan-400" : "text-slate-500 group-hover/item:text-slate-300"}`} />
                    <span className="font-medium text-sm whitespace-nowrap opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200 delay-100 overflow-hidden">
                      {label}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0 opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200 delay-100">
                    {badge !== undefined && badge > 0 && (
                      <span className="bg-amber-500 text-black text-xs font-bold px-2 py-0.5 rounded-full min-w-[20px] text-center">
                        {badge}
                      </span>
                    )}
                    {active && <ChevronRight className="w-4 h-4 text-cyan-400" />}
                  </div>
                </div>
              </Link>
            );
          })}
        </nav>

        {/* User + Logout */}
        <div className="p-3 border-t border-slate-800/60 flex-shrink-0">
          <div className="bg-slate-800/40 rounded-xl p-2.5 mb-2">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center flex-shrink-0">
                <User className="w-4 h-4 text-white" />
              </div>
              <div className="min-w-0 opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200 delay-100 overflow-hidden">
                <p className="text-white text-sm font-medium truncate whitespace-nowrap">{user?.name}</p>
                <p className="text-slate-500 text-xs truncate whitespace-nowrap">{user?.role}</p>
              </div>
            </div>
          </div>
          <button
            onClick={handleLogout}
            title="Sign Out"
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-slate-400 hover:text-red-400 hover:bg-red-900/10 transition-all duration-200 text-sm font-medium"
          >
            <LogOut className="w-4 h-4 flex-shrink-0" />
            <span className="whitespace-nowrap opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200 delay-100">
              Sign Out
            </span>
          </button>
        </div>
      </aside>

      {/* Main — margin adjusts with sidebar width via transition */}
      <main
        className="
          flex-1 min-h-screen
          ml-[68px]
          transition-[margin-left] duration-300 ease-in-out
        "
        style={{}}
      >
        {children}
      </main>
    </div>
  );
}
