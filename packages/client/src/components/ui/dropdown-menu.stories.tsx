import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  Cloud,
  CreditCard,
  Github,
  Keyboard,
  LogOut,
  Mail,
  MessageSquare,
  Plus,
  PlusCircle,
  Settings,
  User,
  UserPlus,
  Users,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const meta = {
  title: 'UI/DropdownMenu',
  component: DropdownMenu,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof DropdownMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button data-testid="dropdown-trigger" variant="outline">
          Open Menu
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuItem data-testid="dropdown-item-profile">
            <User />
            Profile
          </DropdownMenuItem>
          <DropdownMenuItem data-testid="dropdown-item-billing">
            <CreditCard />
            Billing
          </DropdownMenuItem>
          <DropdownMenuItem data-testid="dropdown-item-settings">
            <Settings />
            Settings
          </DropdownMenuItem>
          <DropdownMenuItem data-testid="dropdown-item-shortcuts">
            <Keyboard />
            Keyboard shortcuts
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem data-testid="dropdown-item-team">
            <Users />
            Team
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <UserPlus />
              Invite users
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>
                <Mail />
                Email
              </DropdownMenuItem>
              <DropdownMenuItem>
                <MessageSquare />
                Message
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem>
                <PlusCircle />
                More...
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem data-testid="dropdown-item-new-team">
            <Plus />
            New Team
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem data-testid="dropdown-item-github">
          <Github />
          GitHub
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="dropdown-item-support">
          <Cloud />
          Support
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem data-testid="dropdown-item-logout">
          <LogOut />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

export const ExtraSmall: Story = {
  render: () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button data-testid="dropdown-trigger-xs" variant="outline" size="xs">
          Compact Menu
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent size="xs" className="w-44">
        <DropdownMenuGroup>
          <DropdownMenuItem size="xs">
            <User />
            Profile
          </DropdownMenuItem>
          <DropdownMenuItem size="xs">
            <Settings />
            Settings
          </DropdownMenuItem>
          <DropdownMenuItem size="xs">
            <Keyboard />
            Shortcuts
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem size="xs">
          <Github />
          GitHub
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem size="xs">
          <LogOut />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

export const Simple: Story = {
  render: () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm">
          Actions
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Edit</DropdownMenuItem>
        <DropdownMenuItem>Duplicate</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive">Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

export const AllSizes: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="xs">
            Extra Small
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent size="xs">
          <DropdownMenuItem size="xs">
            <Settings /> Settings
          </DropdownMenuItem>
          <DropdownMenuItem size="xs">
            <User /> Profile
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem size="xs">
            <LogOut /> Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            Small
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent size="sm">
          <DropdownMenuItem size="sm">
            <Settings /> Settings
          </DropdownMenuItem>
          <DropdownMenuItem size="sm">
            <User /> Profile
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem size="sm">
            <LogOut /> Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">Default</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>
            <Settings /> Settings
          </DropdownMenuItem>
          <DropdownMenuItem>
            <User /> Profile
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem>
            <LogOut /> Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  ),
};

export const WithDisabledItems: Story = {
  render: () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Options</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Copy</DropdownMenuItem>
        <DropdownMenuItem>Paste</DropdownMenuItem>
        <DropdownMenuItem disabled>Cut (disabled)</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem>Select All</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};
