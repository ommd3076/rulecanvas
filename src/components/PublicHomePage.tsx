import React from 'react';
import { Button } from '@/components/base/buttons/button';
import {
  RiArrowDownLine,
  RiArrowRightLine,
  RiCheckLine,
  RiGitBranchLine,
  RiHistoryLine,
  RiFocus3Line,
  RiShieldCheckLine,
} from '@remixicon/react';

export function PublicHomePage({ onOpenWorkspace }: { onOpenWorkspace: () => void }) {
  return (
    <main id="top" className="min-h-full bg-background-full text-text-primary motion-safe:animate-number-fade">
      <header className="border-b border-separator-border bg-background-primary-default">
        <div className="mx-auto flex min-h-16 max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-3 px-4 py-3 sm:flex-nowrap sm:px-8 lg:px-10">
          <a href="#top" className="flex items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring" aria-label="RuleCanvas home">
            <span className="grid size-8 place-items-center rounded-xl bg-text-primary text-body-medium text-background-primary-default">R</span>
            <span className="text-title-3-semibold text-text-primary">RuleCanvas</span>
          </a>
          <nav aria-label="Main navigation" className="order-last flex w-full items-center gap-6 sm:order-none sm:w-auto">
            <a href="#workflow" className="text-body-2-medium text-text-secondary outline-none transition-colors hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring">How it works</a>
            <a href="#capabilities" className="text-body-2-medium text-text-secondary outline-none transition-colors hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring">Capabilities</a>
          </nav>
          <Button variant="primary" size="small" trailingIcon={RiArrowRightLine} onClick={onOpenWorkspace}>Open workspace</Button>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-7xl flex-col gap-16 px-4 py-10 sm:gap-20 sm:px-8 sm:py-16 lg:px-10">
        <section aria-labelledby="home-title" className="grid items-center gap-10 lg:grid-cols-[0.92fr_1.08fr] lg:gap-14">
          <div className="flex flex-col items-start">
            <h1 id="home-title" className="max-w-2xl text-display-2-semibold text-text-primary sm:text-display-1-semibold">
              Build and test business rules visually.
            </h1>
            <p className="mt-5 max-w-xl text-body-large-regular text-text-secondary">
              Build deterministic decision flows, test typed inputs, and follow the exact path that produced each outcome.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-4">
              <Button variant="primary" size="medium" trailingIcon={RiArrowRightLine} onClick={onOpenWorkspace}>Open workspace</Button>
              <span className="text-body-2-regular text-text-tertiary">Start with a project or a guided rule example.</span>
            </div>
          </div>

          <div aria-label="Illustrative decision graph preview" className="rounded-3xl border border-border-button-default bg-background-primary-default p-4 shadow-xs sm:p-6">
            <p className="border-b border-separator-border pb-4 text-title-3-semibold text-text-primary">Example decision flow</p>

            <div className="mx-auto flex max-w-xl flex-col items-center py-6 sm:py-8">
              <div className="flex w-full max-w-56 items-center gap-3 rounded-2xl border border-border-button-default bg-background-secondary-default px-4 py-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-background-primary-default text-foreground-icon-secondary"><RiArrowRightLine className="size-4" aria-hidden="true" /></span>
                <span><span className="block text-caption-1-medium text-text-tertiary">ENTRY</span><span className="text-body-medium text-text-primary">Start</span></span>
              </div>
              <RiArrowDownLine className="my-2 size-5 text-foreground-icon-quaternary" aria-hidden="true" />
              <div className="flex w-full max-w-72 items-center gap-3 rounded-2xl border border-border-button-default bg-background-primary-default px-4 py-3 shadow-xs">
                <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-background-secondary-default text-foreground-icon-secondary"><RiGitBranchLine className="size-4" aria-hidden="true" /></span>
                <span className="min-w-0"><span className="block text-caption-1-medium text-text-tertiary">CONDITION</span><span className="text-body-medium text-text-primary">score ≥ threshold?</span></span>
              </div>

              <div className="mt-3 grid w-full grid-cols-2 gap-3 sm:mt-4 sm:gap-5">
                <div className="flex flex-col items-center">
                  <span className="mb-2 rounded-full bg-status-lime-background px-2.5 py-1 text-caption-1-semibold text-status-lime-text">TRUE</span>
                  <RiArrowDownLine className="mb-2 size-4 text-foreground-icon-quaternary" aria-hidden="true" />
                  <div className="w-full rounded-2xl border border-status-lime-text/30 bg-status-lime-background/30 p-3 text-center sm:p-4">
                    <RiCheckLine className="mx-auto mb-1 size-5 text-status-lime-text" aria-hidden="true" />
                    <span className="block text-caption-1-medium text-text-tertiary">OUTCOME</span>
                    <span className="text-body-medium text-text-primary">Proceed</span>
                  </div>
                </div>
                <div className="flex flex-col items-center">
                  <span className="mb-2 rounded-full bg-status-amber-background px-2.5 py-1 text-caption-1-semibold text-status-amber-text">FALSE</span>
                  <RiArrowDownLine className="mb-2 size-4 text-foreground-icon-quaternary" aria-hidden="true" />
                  <div className="w-full rounded-2xl border border-status-amber-text/30 bg-status-amber-background/30 p-3 text-center sm:p-4">
                    <RiShieldCheckLine className="mx-auto mb-1 size-5 text-status-amber-text" aria-hidden="true" />
                    <span className="block text-caption-1-medium text-text-tertiary">OUTCOME</span>
                    <span className="text-body-medium text-text-primary">Review</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="workflow" aria-labelledby="workflow-title" className="scroll-mt-8">
          <div className="max-w-2xl">
            <h2 id="workflow-title" className="text-title-1-semibold text-text-primary">From rule to test result</h2>
          </div>
          <div className="mt-7 grid grid-cols-1 gap-4 md:grid-cols-3">
            <article className="rounded-3xl border border-border-button-default bg-background-primary-default p-5 sm:p-6">
              <span className="grid size-10 place-items-center rounded-2xl bg-background-secondary-default text-foreground-icon-secondary"><RiGitBranchLine className="size-5" aria-hidden="true" /></span>
              <h3 className="mt-4 text-title-3-semibold text-text-primary">Build a decision graph</h3>
              <p className="mt-2 text-body-regular text-text-secondary">Connect typed conditions, nested AND/OR groups, and named outcomes on a visual canvas.</p>
            </article>
            <article className="rounded-3xl border border-border-button-default bg-background-primary-default p-5 sm:p-6">
              <span className="grid size-10 place-items-center rounded-2xl bg-background-secondary-default text-foreground-icon-secondary"><RiFocus3Line className="size-5" aria-hidden="true" /></span>
              <h3 className="mt-4 text-title-3-semibold text-text-primary">Check real input cases</h3>
              <p className="mt-2 text-body-regular text-text-secondary">Validate the graph, enter schema-typed values, and inspect the condition and branch decisions.</p>
            </article>
            <article className="rounded-3xl border border-border-button-default bg-background-primary-default p-5 sm:p-6">
              <span className="grid size-10 place-items-center rounded-2xl bg-background-secondary-default text-foreground-icon-secondary"><RiHistoryLine className="size-5" aria-hidden="true" /></span>
              <h3 className="mt-4 text-title-3-semibold text-text-primary">Save versions you can replay</h3>
              <p className="mt-2 text-body-regular text-text-secondary">Keep immutable snapshots separate from drafts and compare results against a specific version.</p>
            </article>
          </div>
        </section>

        <section id="capabilities" aria-labelledby="capabilities-title" className="scroll-mt-8 rounded-3xl border border-border-button-default bg-background-secondary-default p-5 sm:p-8 lg:p-10">
          <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:items-start">
            <div>
              <h2 id="capabilities-title" className="text-title-1-semibold text-text-primary">Decision records and releases</h2>
              <p className="mt-3 text-body-regular text-text-secondary">Inspect input values during a test. Run history keeps the version and outcome.</p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border border-border-button-default bg-background-primary-default p-4">
                <h3 className="text-body-medium text-text-primary">Typed inputs</h3>
                <p className="mt-1 text-body-2-regular text-text-secondary">String, number, boolean, date, and enum fields with required-state validation.</p>
              </div>
              <div className="rounded-2xl border border-border-button-default bg-background-primary-default p-4">
                <h3 className="text-body-medium text-text-primary">Ordered traces</h3>
                <p className="mt-1 text-body-2-regular text-text-secondary">Step through evaluated nodes, actual values, branch results, and terminal outcomes.</p>
              </div>
              <div className="rounded-2xl border border-border-button-default bg-background-primary-default p-4">
                <h3 className="text-body-medium text-text-primary">Version history</h3>
                <p className="mt-1 text-body-2-regular text-text-secondary">Replay an immutable snapshot independently of later draft edits.</p>
              </div>
              <div className="rounded-2xl border border-border-button-default bg-background-primary-default p-4">
                <h3 className="text-body-medium text-text-primary">Hosted review and release</h3>
                <p className="mt-1 text-body-2-regular text-text-secondary">When hosted release management is configured, assigned roles review versions before environment activation.</p>
              </div>
            </div>
          </div>
        </section>

        <section aria-labelledby="home-cta-title" className="flex flex-col items-start justify-between gap-5 border-t border-separator-border pt-8 sm:flex-row sm:items-center sm:pt-10">
          <div>
            <h2 id="home-cta-title" className="text-title-2-semibold text-text-primary">Create your first rule set</h2>
            <p className="mt-1 text-body-regular text-text-secondary">Open the workspace to build a graph or try the guided example.</p>
          </div>
          <Button variant="primary" size="medium" trailingIcon={RiArrowRightLine} onClick={onOpenWorkspace}>Open workspace</Button>
        </section>

      </div>
    </main>
  );
}
