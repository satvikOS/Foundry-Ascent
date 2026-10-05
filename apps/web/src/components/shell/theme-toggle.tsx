import { Monitor, Moon, Sun } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useTheme, type ThemePreference } from '@/lib/theme';

export const THEME_OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'light', label: 'Light', icon: Sun },
];

/** Theme menu (system / dark / light), persisted per browser. */
export function ThemeToggle() {
  const { preference, resolved, setTheme } = useTheme();
  const Icon = preference === 'system' ? Monitor : resolved === 'dark' ? Moon : Sun;
  const current = THEME_OPTIONS.find((o) => o.value === preference)?.label ?? 'System';
  return (
    <DropdownMenu>
      <SimpleTooltip content="Theme">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Theme: ${current}`}>
            <Icon aria-hidden />
          </Button>
        </DropdownMenuTrigger>
      </SimpleTooltip>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={preference}
          onValueChange={(value) => {
            setTheme(value as ThemePreference);
          }}
        >
          {THEME_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              <option.icon aria-hidden />
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
