import { useTerminalStore, type TerminalTab } from '../../stores/terminalStore';
import { soundEffects } from '../../audio/SoundEffects';
import EmailTab from './tabs/EmailTab';
import InstallationsTab from './tabs/InstallationsTab';
import CommandsTab from './tabs/CommandsTab';
import OptionsTab from './tabs/OptionsTab';
import NetworkTab from './tabs/NetworkTab';

const TABS: { id: TerminalTab; label: string }[] = [
  { id: 'installations', label: 'INSTALLATIONS' },
  { id: 'email', label: 'EMAIL' },
  { id: 'network', label: 'NETWORK' },
  { id: 'commands', label: 'COMMANDS' },
  { id: 'options', label: 'OPTIONS' },
];

export default function TerminalScreen() {
  const activeTab = useTerminalStore((s) => s.activeTab);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);
  const getUnreadCount = useTerminalStore((s) => s.getUnreadCount);

  const unreadCount = getUnreadCount();

  return (
    <div className="terminal-screen">
      <div className="terminal-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`terminal-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => {
              soundEffects.playClick();
              setActiveTab(tab.id);
            }}
          >
            {tab.label}
            {tab.id === 'email' && unreadCount > 0 && (
              <span className="tab-badge">{unreadCount}</span>
            )}
          </button>
        ))}
      </div>
      <div className="terminal-content">
        {activeTab === 'installations' && <InstallationsTab />}
        {activeTab === 'email' && <EmailTab />}
        {activeTab === 'network' && <NetworkTab />}
        {activeTab === 'commands' && <CommandsTab />}
        {activeTab === 'options' && <OptionsTab />}
      </div>
    </div>
  );
}
