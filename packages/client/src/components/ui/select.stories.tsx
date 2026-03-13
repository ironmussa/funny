import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const meta = {
  title: 'UI/Select',
  component: Select,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Select>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Select>
      <SelectTrigger data-testid="select-trigger" className="w-48" size="default">
        <SelectValue placeholder="Select an option" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="option1" size="default">
          Option 1
        </SelectItem>
        <SelectItem value="option2" size="default">
          Option 2
        </SelectItem>
        <SelectItem value="option3" size="default">
          Option 3
        </SelectItem>
      </SelectContent>
    </Select>
  ),
};

export const ExtraSmall: Story = {
  render: () => (
    <Select>
      <SelectTrigger data-testid="select-trigger-xs" className="w-40" size="xs">
        <SelectValue placeholder="Select..." />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="option1" size="xs">
          Option 1
        </SelectItem>
        <SelectItem value="option2" size="xs">
          Option 2
        </SelectItem>
        <SelectItem value="option3" size="xs">
          Option 3
        </SelectItem>
      </SelectContent>
    </Select>
  ),
};

export const Small: Story = {
  render: () => (
    <Select>
      <SelectTrigger data-testid="select-trigger-sm" className="w-44" size="sm">
        <SelectValue placeholder="Select..." />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="option1" size="sm">
          Option 1
        </SelectItem>
        <SelectItem value="option2" size="sm">
          Option 2
        </SelectItem>
        <SelectItem value="option3" size="sm">
          Option 3
        </SelectItem>
      </SelectContent>
    </Select>
  ),
};

export const AllSizes: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <Select>
        <SelectTrigger data-testid="select-all-xs" className="w-36" size="xs">
          <SelectValue placeholder="Extra Small" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a" size="xs">
            Option A
          </SelectItem>
          <SelectItem value="b" size="xs">
            Option B
          </SelectItem>
        </SelectContent>
      </Select>
      <Select>
        <SelectTrigger data-testid="select-all-sm" className="w-36" size="sm">
          <SelectValue placeholder="Small" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a" size="sm">
            Option A
          </SelectItem>
          <SelectItem value="b" size="sm">
            Option B
          </SelectItem>
        </SelectContent>
      </Select>
      <Select>
        <SelectTrigger data-testid="select-all-default" className="w-36" size="default">
          <SelectValue placeholder="Default" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a" size="default">
            Option A
          </SelectItem>
          <SelectItem value="b" size="default">
            Option B
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  ),
};

export const WithDisabledItems: Story = {
  render: () => (
    <Select>
      <SelectTrigger data-testid="select-disabled-items" className="w-48">
        <SelectValue placeholder="Select..." />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="option1">Enabled</SelectItem>
        <SelectItem value="option2" disabled>
          Disabled
        </SelectItem>
        <SelectItem value="option3">Enabled</SelectItem>
      </SelectContent>
    </Select>
  ),
};
