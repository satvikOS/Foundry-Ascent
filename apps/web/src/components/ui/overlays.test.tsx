import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { CommandDialog, CommandInput, CommandItem, CommandList } from './command';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

/*
 * Where glass goes: floating layers (menus, selects, the command palette) are `.glass-strong`; modal
 * panels holding forms and body text are solid over a dimmed, blurred scrim; nothing glass is ever
 * stacked on another glass layer (a submenu beside its menu, a glass panel over a blurred scrim).
 */

const overlayOf = () => document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]');

describe('overlay surfaces', () => {
  it('a dialog is a solid panel over a blurred scrim', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Rename</DialogTitle>
          <DialogDescription>Give it a name.</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    const panel = screen.getByRole('dialog', { name: 'Rename' });
    expect(panel).toHaveAttribute('data-surface', 'solid');
    expect(panel).toHaveClass('bg-popover');
    expect(panel).not.toHaveClass('glass-strong');
    // Blurred from tablet width up; a full-screen blur is too costly on phones.
    expect(overlayOf()).toHaveClass('sm:backdrop-blur-xs', 'bg-(--scrim)');
  });

  it('the command palette is a glass panel, and its scrim only dims (no glass over blur)', () => {
    render(
      <CommandDialog open title="Search">
        <CommandInput placeholder="Search" />
        <CommandList>
          <CommandItem>Knowledge</CommandItem>
        </CommandList>
      </CommandDialog>,
    );
    const panel = screen.getByRole('dialog', { name: 'Search' });
    expect(panel).toHaveAttribute('data-surface', 'glass');
    expect(panel).toHaveClass('glass-strong');
    expect(panel).not.toHaveClass('bg-popover');
    const overlay = overlayOf();
    expect(overlay).toHaveClass('sm:backdrop-blur-none', 'bg-(--scrim-soft)');
    expect(overlay).not.toHaveClass('sm:backdrop-blur-xs');
  });

  it('a menu is glass; its submenu, which overlaps it, is solid', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Account</DropdownMenuTrigger>
        <DropdownMenuContent aria-label="Account">
          <DropdownMenuItem>Shortcuts</DropdownMenuItem>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>Theme</DropdownMenuSubTrigger>
            <DropdownMenuSubContent aria-label="Theme">
              <DropdownMenuItem>Dark</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await user.click(screen.getByRole('button', { name: 'Account' }));
    const menus = await screen.findAllByRole('menu');
    const [menu, submenu] = menus;
    expect(menu).toHaveClass('glass-strong');
    expect(menu).not.toHaveClass('bg-popover');
    expect(submenu).toHaveClass('bg-popover');
    expect(submenu).not.toHaveClass('glass-strong');
  });

  it('a select’s list floats as glass', async () => {
    const user = userEvent.setup();
    render(
      <Select defaultValue="all">
        <SelectTrigger aria-label="Role">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All roles</SelectItem>
          <SelectItem value="eir">EIR</SelectItem>
        </SelectContent>
      </Select>,
    );
    await user.click(screen.getByRole('combobox', { name: 'Role' }));
    expect(await screen.findByRole('listbox')).toHaveClass('glass-strong');
  });
});
