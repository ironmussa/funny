import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
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
      <SelectTrigger data-testid="select-trigger" className="w-48">
        <SelectValue placeholder="Select an option" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="option1">Option 1</SelectItem>
        <SelectItem value="option2">Option 2</SelectItem>
        <SelectItem value="option3">Option 3</SelectItem>
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
        <SelectTrigger data-testid="select-all-md" className="w-36" size="md">
          <SelectValue placeholder="Medium" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a" size="md">
            Option A
          </SelectItem>
          <SelectItem value="b" size="md">
            Option B
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  ),
};

export const WithGroups: Story = {
  render: () => (
    <Select>
      <SelectTrigger data-testid="select-groups" className="w-56">
        <SelectValue placeholder="Select a fruit" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Tropical</SelectLabel>
          <SelectItem value="mango">Mango</SelectItem>
          <SelectItem value="pineapple">Pineapple</SelectItem>
          <SelectItem value="coconut">Coconut</SelectItem>
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel>Berries</SelectLabel>
          <SelectItem value="strawberry">Strawberry</SelectItem>
          <SelectItem value="blueberry">Blueberry</SelectItem>
          <SelectItem value="raspberry">Raspberry</SelectItem>
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel>Citrus</SelectLabel>
          <SelectItem value="orange">Orange</SelectItem>
          <SelectItem value="lemon">Lemon</SelectItem>
          <SelectItem value="grapefruit">Grapefruit</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
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

export const WithPreselectedValue: Story = {
  render: () => (
    <Select defaultValue="sonnet">
      <SelectTrigger data-testid="select-preselected" className="w-48">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="haiku">Haiku</SelectItem>
        <SelectItem value="sonnet">Sonnet</SelectItem>
        <SelectItem value="opus">Opus</SelectItem>
      </SelectContent>
    </Select>
  ),
};

export const Disabled: Story = {
  render: () => (
    <Select disabled>
      <SelectTrigger data-testid="select-disabled" className="w-48">
        <SelectValue placeholder="Disabled select" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="option1">Option 1</SelectItem>
        <SelectItem value="option2">Option 2</SelectItem>
      </SelectContent>
    </Select>
  ),
};

export const ManyOptions: Story = {
  render: () => (
    <Select>
      <SelectTrigger data-testid="select-many-options" className="w-56">
        <SelectValue placeholder="Select a timezone" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Americas</SelectLabel>
          <SelectItem value="est">Eastern (UTC-5)</SelectItem>
          <SelectItem value="cst">Central (UTC-6)</SelectItem>
          <SelectItem value="mst">Mountain (UTC-7)</SelectItem>
          <SelectItem value="pst">Pacific (UTC-8)</SelectItem>
          <SelectItem value="akst">Alaska (UTC-9)</SelectItem>
          <SelectItem value="hst">Hawaii (UTC-10)</SelectItem>
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel>Europe</SelectLabel>
          <SelectItem value="gmt">GMT (UTC+0)</SelectItem>
          <SelectItem value="cet">CET (UTC+1)</SelectItem>
          <SelectItem value="eet">EET (UTC+2)</SelectItem>
          <SelectItem value="msk">Moscow (UTC+3)</SelectItem>
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel>Asia</SelectLabel>
          <SelectItem value="ist">India (UTC+5:30)</SelectItem>
          <SelectItem value="cst-asia">China (UTC+8)</SelectItem>
          <SelectItem value="jst">Japan (UTC+9)</SelectItem>
          <SelectItem value="kst">Korea (UTC+9)</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  ),
};
