import { BrowserRouter as Router, Routes, Route, useLocation } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import RightPanel from './components/RightPanel';
import BackgroundEffects from './components/BackgroundEffects';
import ApprovalPopup from './components/ApprovalPopup';
import { AIOSProvider } from './state/useAIOS';
import Home from './pages/Home';
import NewChat from './pages/NewChat';
import Chats from './pages/Chats';
import Tasks from './pages/Tasks';
import Memory from './pages/Memory';
import Jobs from './pages/Jobs';
import Settings from './pages/Settings';

function Layout() {
  const location = useLocation();
  // Hide the right panel on specific full-width pages
  const hideRightPanelPaths = ['/settings', '/memory', '/new', '/chats'];
  const showRightPanel = !hideRightPanelPaths.includes(location.pathname);

  return (
    <div className="flex h-screen w-full bg-[#05070A] text-[#F7F9FC] overflow-hidden font-sans relative selection:bg-[#3B82F6]/30">
      <BackgroundEffects />

      <div className="flex w-full h-full z-10 p-5 gap-5">
        <Sidebar />
        <div className="flex-1 flex overflow-hidden relative min-w-0">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/new" element={<NewChat />} />
            <Route path="/chats" element={<Chats />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/memory" element={<Memory />} />
            <Route path="/jobs" element={<Jobs />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </div>
        {showRightPanel && <RightPanel />}
      </div>

      {/* Approvals pop over EVERYTHING, on every page. */}
      <ApprovalPopup />
    </div>
  );
}

export default function App() {
  return (
    <AIOSProvider>
      <Router>
        <Layout />
      </Router>
    </AIOSProvider>
  );
}
