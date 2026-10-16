import type { MemoryObjectView } from '@foundry/contracts';
import { getRouteApi } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useCallback, useState } from 'react';

import { Inspector, useInspector } from '@/components/shell/inspector';
import { Button } from '@/components/ui/button';
import { InspectorSection } from '@/components/ui/inspector-panel';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useMemory } from '@/lib/api/hooks/memory';
import { useVenture } from '@/lib/api/hooks/ventures';
import { canWrite, isAssignedEir } from '@/lib/auth/roles';
import { useRequiredMe } from '@/lib/auth/use-me';
import { CreateMemoryDialog } from '@/features/memory/memory-dialogs';
import { MemoryDetail } from '@/features/memory/memory-detail';
import { TypedMemoryDialog, type TypedKind } from '@/features/memory/typed/typed-memory-dialog';
import { useVeirName } from '@/features/venture/veir-name';

import { DigestsSection } from './digests-section';
import { EvidenceSection } from './evidence-section';
import { MemorySection } from './memory-section';
import { NotebookEditor } from './notebook-section';
import { ReviewQueue } from './review-queue';
import type { KnowledgeSearch, KnowledgeView } from './search';

const routeApi = getRouteApi('/$tenant/app/v/$ventureId/knowledge');

/** The memory list is the page's default section; it has no `view` in the URL. */
type Tab = 'memory' | KnowledgeView;

function typedKind(type: KnowledgeSearch['type']): TypedKind | null {
  return type === 'decision' || type === 'experiment' || type === 'milestone' ? type : null;
}

/**
 * Knowledge: the venture's specific pool in one place. Memory the team kept (with type chips, status
 * and search), the "To review" queue, the vEIR's notebook, conversation digests and the evidence it can
 * cite. A memory item opens in the side panel.
 */
export function KnowledgePage() {
  const me = useRequiredMe();
  const { tenant, ventureId } = routeApi.useParams();
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const venture = useVenture(ventureId);
  const veirName = useVeirName(ventureId);
  const { setOpen } = useInspector();
  const team = canWrite(me, ventureId);
  // The team writes in the notebook; the assigned EIR reads it; advisors never see it.
  const notebookVisible = team || isAssignedEir(me, ventureId);
  const [creating, setCreating] = useState(false);
  const [typedEditing, setTypedEditing] = useState<MemoryObjectView | null>(null);

  const setSearch = useCallback(
    (patch: Partial<KnowledgeSearch>, replace = true) =>
      void navigate({ search: (previous) => ({ ...previous, ...patch }), replace }),
    [navigate],
  );
  const select = (memoryId: string | undefined) => {
    setSearch({ m: memoryId }, false);
    if (memoryId) setOpen(true);
  };

  const tabs: { value: Tab; label: string }[] = [
    { value: 'memory', label: 'Memory' },
    { value: 'proposed', label: 'To review' },
    ...(notebookVisible ? [{ value: 'notebook' as const, label: 'Notebook' }] : []),
    ...(team ? [{ value: 'conversations' as const, label: 'Conversations' }] : []),
    { value: 'evidence', label: 'Evidence' },
  ];
  const requested: Tab = search.view ?? 'memory';
  const tab: Tab = tabs.some((t) => t.value === requested) ? requested : 'memory';

  // The detail panel looks the item up in the cached lists (kept memory and proposals).
  const all = useMemory(ventureId);
  const proposed = useMemory(ventureId, { status: 'proposed' });
  const selected =
    search.m === undefined
      ? null
      : (all.data?.find((item) => item.id === search.m) ??
        proposed.data?.find((item) => item.id === search.m) ??
        null);
  const pending = proposed.data?.length ?? venture.data?.pendingMemory ?? 0;

  const kind = typedKind(search.type);
  const editKind = typedEditing ? typedKind(typedEditing.type) : null;
  const createLabel = kind ? `Add ${kind}` : 'Add memory';
  const ventureName = venture.data?.name ?? 'this venture';

  return (
    <PageContainer className="max-w-4xl">
      <Tabs
        value={tab}
        onValueChange={(value) => {
          // The open memory item belongs to the section it was opened from.
          setSearch({ view: value === 'memory' ? undefined : (value as KnowledgeView), m: undefined }, false);
        }}
        className="gap-0"
      >
        <PageHeader
          title="Knowledge"
          description={`What ${veirName} knows about ${ventureName}, and where it came from.`}
          actions={
            tab === 'memory' && team ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setCreating(true);
                }}
              >
                <Plus aria-hidden />
                {createLabel}
              </Button>
            ) : null
          }
        >
          <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0">
            <TabsList variant="underline" aria-label="Knowledge sections" className="min-w-max gap-5">
              {tabs.map((t) => (
                <TabsTrigger key={t.value} value={t.value}>
                  {t.label}
                  {t.value === 'proposed' && pending > 0 ? (
                    <span className="tabular rounded-sm bg-warning/15 px-1 text-[11px] leading-4 text-warning">
                      {pending}
                      <span className="sr-only"> waiting</span>
                    </span>
                  ) : null}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </PageHeader>

        <TabsContent value="memory">
          <MemorySection
            ventureId={ventureId}
            search={search}
            setSearch={setSearch}
            onSelect={select}
            canEdit={team}
            onCreate={() => {
              setCreating(true);
            }}
            createLabel={createLabel}
          />
        </TabsContent>
        <TabsContent value="proposed">
          <ReviewQueue
            ventureId={ventureId}
            tenant={tenant}
            canEdit={team}
            veirName={veirName}
            onOpenDetail={select}
          />
        </TabsContent>
        {notebookVisible ? (
          <TabsContent value="notebook">
            <NotebookEditor ventureId={ventureId} veirName={veirName} canEdit={team} />
          </TabsContent>
        ) : null}
        {team ? (
          <TabsContent value="conversations">
            <DigestsSection ventureId={ventureId} tenant={tenant} veirName={veirName} canEdit={team} />
          </TabsContent>
        ) : null}
        <TabsContent value="evidence">
          <EvidenceSection
            ventureId={ventureId}
            tenant={tenant}
            veirName={veirName}
            canReadConversations={team}
          />
        </TabsContent>
      </Tabs>

      {search.m ? (
        <Inspector title="Memory" description="Source, history and actions">
          {selected ? (
            <MemoryDetail
              memory={selected}
              tenant={tenant}
              ventureId={ventureId}
              canEdit={team}
              onEdit={
                typedKind(selected.type)
                  ? () => {
                      setTypedEditing(selected);
                    }
                  : undefined
              }
              onRemoved={() => {
                select(undefined);
              }}
            />
          ) : all.isPending || proposed.isPending ? (
            <div className="grid gap-3 p-4" aria-busy="true">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-6 w-3/4" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : (
            <InspectorSection title="Memory">
              <p className="text-[13px] text-muted-foreground">This item is no longer in memory.</p>
              <Button
                className="mt-3"
                size="sm"
                variant="secondary"
                onClick={() => {
                  select(undefined);
                }}
              >
                Clear selection
              </Button>
            </InspectorSection>
          )}
        </Inspector>
      ) : null}

      {kind ? (
        <TypedMemoryDialog ventureId={ventureId} kind={kind} open={creating} onOpenChange={setCreating} />
      ) : (
        <CreateMemoryDialog
          ventureId={ventureId}
          open={creating}
          onOpenChange={setCreating}
          defaults={search.type ? { type: search.type } : undefined}
          onCreated={(memory) => {
            select(memory.id);
          }}
        />
      )}
      {typedEditing && editKind ? (
        <TypedMemoryDialog
          ventureId={ventureId}
          kind={editKind}
          open
          memory={typedEditing}
          onOpenChange={(open) => {
            if (!open) setTypedEditing(null);
          }}
        />
      ) : null}
    </PageContainer>
  );
}
