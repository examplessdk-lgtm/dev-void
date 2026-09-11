import { useId, useState } from 'react';
import cx from '../../lib/cx.tsx';

type CodeTab = Readonly<{
  code: string;
  label: string;
  language?: string;
  prefix?: string;
}>;

type CodeGroupProps = Readonly<{
  tabs: ReadonlyArray<CodeTab>;
}>;

export default function CodeGroup({ tabs }: CodeGroupProps) {
  const [activeTab, setActiveTab] = useState(0);
  const groupId = useId();

  return (
    <div className="code-group">
      <div className="code-group__tabs">
        <div className="tabs">
          {tabs.map((tab, index) => (
            <div key={`${tab.label}-${index}`}>
              <input
                checked={index === activeTab}
                id={`tab-${groupId}-${index}`}
                name={`code-group-tabs-${groupId}`}
                onChange={() => setActiveTab(index)}
                type="radio"
              />
              <label htmlFor={`tab-${groupId}-${index}`}>{tab.label}</label>
            </div>
          ))}
        </div>
        {tabs.map((tab, index) => (
          <div
            className={cx(`language-${tab.language || 'bash'}`, index === activeTab && 'active')}
            key={`content-${index}`}
          >
            <button aria-label="Copy code" className="copy" type="button" />
            <span className="lang">{tab.language || 'bash'}</span>
            <pre>
              <code>
                {tab.prefix ? (
                  <span style={{ userSelect: 'none', WebkitUserSelect: 'none' }}>{tab.prefix}</span>
                ) : null}
                <span>{tab.code}</span>
              </code>
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
