import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogCancelButton,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

/* ------------------------------------------------------------------ */
/*  Storybook meta                                                    */
/* ------------------------------------------------------------------ */

const meta: Meta<typeof Dialog> = {
  title: 'UI/Dialog',
  component: Dialog,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

/* ------------------------------------------------------------------ */
/*  Stories                                                            */
/* ------------------------------------------------------------------ */

/** Default dialog with trigger button. */
export const Default: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button data-testid="dialog-trigger">Open Dialog</Button>
      </DialogTrigger>
      <DialogContent data-testid="dialog-content">
        <DialogHeader>
          <DialogTitle>Dialog Title</DialogTitle>
          <DialogDescription>
            This is a description of the dialog. It provides context about the action being taken.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">Dialog body content goes here.</p>
        <DialogFooter>
          <DialogCancelButton data-testid="dialog-cancel" />
          <Button data-testid="dialog-confirm">Confirm</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
};

/** Dialog with a form inside. */
export const WithForm: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button data-testid="dialog-trigger">Edit Profile</Button>
      </DialogTrigger>
      <DialogContent data-testid="dialog-content">
        <DialogHeader>
          <DialogTitle>Edit Profile</DialogTitle>
          <DialogDescription>
            Make changes to your profile here. Click save when you're done.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid grid-cols-4 items-center gap-4">
            <label htmlFor="name" className="text-right text-sm font-medium">
              Name
            </label>
            <Input
              id="name"
              defaultValue="John Doe"
              className="col-span-3"
              data-testid="dialog-input-name"
            />
          </div>
          <div className="grid grid-cols-4 items-center gap-4">
            <label htmlFor="email" className="text-right text-sm font-medium">
              Email
            </label>
            <Input
              id="email"
              defaultValue="john@example.com"
              className="col-span-3"
              data-testid="dialog-input-email"
            />
          </div>
        </div>
        <DialogFooter>
          <Button data-testid="dialog-save">Save changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
};

/** Dialog without description. */
export const TitleOnly: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="destructive" data-testid="dialog-trigger">
          Delete Item
        </Button>
      </DialogTrigger>
      <DialogContent data-testid="dialog-content">
        <DialogHeader>
          <DialogTitle>Are you sure?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">This action cannot be undone.</p>
        <DialogFooter>
          <DialogCancelButton data-testid="dialog-cancel" />
          <Button variant="destructive" data-testid="dialog-confirm">
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
};

/** Dialog with long scrollable content. */
export const LongContent: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" data-testid="dialog-trigger">
          View Terms
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[80vh] overflow-y-auto" data-testid="dialog-content">
        <DialogHeader>
          <DialogTitle>Terms of Service</DialogTitle>
          <DialogDescription>Please read the following terms carefully.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm text-muted-foreground">
          {Array.from({ length: 10 }, (_, i) => (
            <p key={i}>
              Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor
              incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud
              exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.
            </p>
          ))}
        </div>
        <DialogFooter>
          <DialogCancelButton data-testid="dialog-decline">Decline</DialogCancelButton>
          <Button data-testid="dialog-accept">Accept</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
};

/** Destructive action dialog. */
export const Destructive: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="destructive" data-testid="dialog-trigger">
          Delete Project
        </Button>
      </DialogTrigger>
      <DialogContent data-testid="dialog-content">
        <DialogHeader>
          <DialogTitle>Delete Project</DialogTitle>
          <DialogDescription>
            This will permanently delete the project and all associated data. This action cannot be
            undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogCancelButton data-testid="dialog-cancel" />
          <Button variant="destructive" data-testid="dialog-delete">
            Delete Project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
};

/* ------------------------------------------------------------------ */
/*  Interaction tests                                                 */
/* ------------------------------------------------------------------ */

export const OpenAndClose: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button data-testid="dialog-trigger">Open</Button>
      </DialogTrigger>
      <DialogContent data-testid="dialog-content">
        <DialogHeader>
          <DialogTitle>Test Dialog</DialogTitle>
          <DialogDescription>Testing open and close.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button data-testid="dialog-ok">Confirm action</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByTestId('dialog-trigger');
    await userEvent.click(trigger);

    const body = within(canvasElement.ownerDocument.body);
    await waitFor(() => {
      const content = body.getByTestId('dialog-content');
      expect(content).toBeVisible();
    });
  },
};
