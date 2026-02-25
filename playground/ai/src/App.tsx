import { useState } from "react";

import Chat from "./Chat";
import ModelExplorer from "./ModelExplorer";

const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct";

export default function App() {
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL);

  return (
    <>
      <nav className="nav">
        <div className="nav-brand">
          <span>void</span>/ai
        </div>
      </nav>
      <div className="layout">
        <ModelExplorer selectedModel={selectedModel} onSelectModel={setSelectedModel} />
        <Chat model={selectedModel} />
      </div>
    </>
  );
}
