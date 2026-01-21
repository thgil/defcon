import { useState, useEffect, useRef } from 'react';
import { useTerminalStore, type Email } from '../../../stores/terminalStore';
import { useEvilAI } from '../../../hooks/useEvilAI';

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

interface EmailListItemProps {
  email: Email;
  isSelected: boolean;
  onClick: () => void;
  corrupt?: (text: string) => string;
}

function EmailListItem({ email, isSelected, onClick, corrupt }: EmailListItemProps) {
  const displaySubject = corrupt && email.isAI ? corrupt(email.subject) : email.subject;

  return (
    <div
      className={`email-item ${isSelected ? 'selected' : ''} ${!email.read ? 'unread' : ''} ${email.isAI ? 'ai-email' : ''}`}
      onClick={onClick}
    >
      <span className="email-indicator">{email.read ? ' ' : '*'}</span>
      <span className="email-time">{formatTime(email.timestamp)}</span>
      <span className="email-from">{email.from.substring(0, 20).padEnd(20)}</span>
      <span className="email-subject">{displaySubject}</span>
    </div>
  );
}

interface EmailViewProps {
  email: Email;
  onBack: () => void;
  corrupt?: (text: string) => string;
}

function EmailView({ email, onBack, corrupt }: EmailViewProps) {
  const displayBody = corrupt && email.isAI ? corrupt(email.body) : email.body;

  return (
    <div className="email-view">
      <div className="email-view-header">
        <button className="email-back-btn" onClick={onBack}>
          &lt; BACK
        </button>
      </div>
      <div className="email-view-meta">
        <div className="email-meta-row">
          <span className="email-meta-label">FROM:</span>
          <span className={`email-meta-value ${email.isAI ? 'ai-text' : ''}`}>
            {email.from}
          </span>
        </div>
        <div className="email-meta-row">
          <span className="email-meta-label">TO:</span>
          <span className="email-meta-value">{email.to}</span>
        </div>
        <div className="email-meta-row">
          <span className="email-meta-label">SUBJECT:</span>
          <span className={`email-meta-value ${email.isAI ? 'ai-text' : ''}`}>
            {email.subject}
          </span>
        </div>
        <div className="email-meta-row">
          <span className="email-meta-label">DATE:</span>
          <span className="email-meta-value">
            {new Date(email.timestamp).toLocaleString()}
          </span>
        </div>
      </div>
      <div className="email-divider">
        ─────────────────────────────────────────────────────────
      </div>
      <div className={`email-body ${email.isAI ? 'ai-text' : ''}`}>
        {displayBody}
      </div>
    </div>
  );
}

export default function EmailTab() {
  const emails = useTerminalStore((s) => s.emails);
  const markEmailRead = useTerminalStore((s) => s.markEmailRead);

  const [selectedEmail, setSelectedEmail] = useState<Email | null>(null);

  const { corruptText, aiPresenceLevel } = useEvilAI();
  const listRef = useRef<HTMLDivElement>(null);

  // Corrupt function only active at higher presence levels
  const corrupt = aiPresenceLevel > 30
    ? (text: string) => corruptText(text)
    : undefined;

  useEffect(() => {
    // Scroll to top when new emails arrive
    if (listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, [emails.length]);

  const handleSelectEmail = (email: Email) => {
    setSelectedEmail(email);
    if (!email.read) {
      markEmailRead(email.id);
    }
  };

  const handleBack = () => {
    setSelectedEmail(null);
  };

  if (selectedEmail) {
    return <EmailView email={selectedEmail} onBack={handleBack} corrupt={corrupt} />;
  }

  return (
    <div className="email-tab">
      <div className="email-header">
        <span className="email-header-col">TIME</span>
        <span className="email-header-col from">FROM</span>
        <span className="email-header-col subject">SUBJECT</span>
      </div>
      <div className="email-list" ref={listRef}>
        {emails.length === 0 ? (
          <div className="email-empty">
            <div>NO MESSAGES</div>
            <div className="email-empty-sub">
              System emails will appear here when events occur.
            </div>
          </div>
        ) : (
          emails.map((email) => (
            <EmailListItem
              key={email.id}
              email={email}
              isSelected={false}
              onClick={() => handleSelectEmail(email)}
              corrupt={corrupt}
            />
          ))
        )}
      </div>
    </div>
  );
}
