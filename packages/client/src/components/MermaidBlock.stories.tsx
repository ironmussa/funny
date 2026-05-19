import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { MermaidBlock, MermaidExpandedDialog } from '@/components/MermaidBlock';
import { Button } from '@/components/ui/button';

const meta = {
  title: 'Components/MermaidBlock',
  component: MermaidBlock,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof MermaidBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

const FLOWCHART = `flowchart TD
  A[Client] --> B[Server]
  B --> C{Auth OK?}
  C -- Yes --> D[Runner]
  C -- No --> E[401]
  D --> F[(Database)]
  D --> G[Git Worktree]`;

const SEQUENCE = `sequenceDiagram
  participant U as User
  participant S as Server
  participant R as Runner
  U->>S: POST /threads
  S->>R: spawn agent
  R-->>S: stream tokens
  S-->>U: WebSocket events`;

const COMPLEX = `flowchart TB
  subgraph "Phase 1 - Initialization"
    A1[Init DB<br/>SQLite] --> A2[Register Known Faces<br/>FaceNet512]
  end
  subgraph "Phase 2 - Scene Splitting"
    B1[Load Video<br/>OpenCV] --> B2[Cut Detection<br/>TransNet V2]
    B2 --> B3[Scene Segmentation]
  end
  subgraph "Phase 3 - Recognition"
    C1[Frame Sampling] --> C2[Face Detection<br/>RetinaFace]
    C2 --> C3[Recognition<br/>FaceNet512]
    C3 --> C4[Emotion Analysis<br/>DeepFace]
  end
  A2 --> B1
  B3 --> C1`;

const CLASS_DIAGRAM = `classDiagram
  class Project {
    +id: string
    +name: string
    +path: string
    +createThread()
  }
  class Thread {
    +id: string
    +mode: local | worktree
    +sendMessage()
  }
  Project "1" --> "*" Thread`;

const INVALID = `flowchart TD
  A --> B
  B -->`;

export const Flowchart: Story = {
  args: { chart: FLOWCHART },
};

export const Sequence: Story = {
  args: { chart: SEQUENCE },
};

export const ComplexWithSubgraphs: Story = {
  args: { chart: COMPLEX },
};

export const ClassDiagram: Story = {
  args: { chart: CLASS_DIAGRAM },
};

export const InvalidSyntax: Story = {
  args: { chart: INVALID },
};

export const ExpandedDialogOnly: Story = {
  args: { chart: COMPLEX },
  render: ({ chart }) => {
    function Demo() {
      const [open, setOpen] = useState(false);
      return (
        <div className="space-y-3">
          <Button onClick={() => setOpen(true)}>Open expanded dialog</Button>
          <MermaidExpandedDialog chart={chart} open={open} onClose={() => setOpen(false)} />
        </div>
      );
    }
    return <Demo />;
  },
};
