type AddProjectOption = {
  id: string;
  title: string;
  description: string;
  featured?: boolean;
};

const OPTIONS: AddProjectOption[] = [
  {
    id: "agent",
    title: "With AI agent",
    description: "Connect Cursor or Claude, then say push this to VibeHub.",
    featured: true,
  },
  {
    id: "github",
    title: "From GitHub",
    description: "Pick a repo you already have — we set up the task board.",
  },
  {
    id: "idea",
    title: "From an idea",
    description: "No code yet — describe it and paste an LLM plan.",
  },
  {
    id: "local",
    title: "From this computer",
    description: "Upload a project folder from your browser.",
  },
];

export function AddProjectPicker({ onPick }: { onPick: (id: string) => void }) {
  return (
    <div className="choice-grid choice-grid--2x2">
      {OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          className={`choice${option.featured ? " choice-featured" : ""}`}
          onClick={() => onPick(option.id)}
        >
          <h3>{option.title}</h3>
          <p>{option.description}</p>
        </button>
      ))}
    </div>
  );
}
