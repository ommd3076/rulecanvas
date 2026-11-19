import React, { Component, type ReactNode } from 'react';
import { RecoveryView } from './RecoveryView';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('RuleCanvas ErrorBoundary caught rendering error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      const path = typeof window !== 'undefined' ? window.location.pathname : '/projects';
      return (
        <div className="flex h-screen w-screen flex-col bg-background-full text-text-primary antialiased">
          <RecoveryView
            state={{
              type: 'not_found',
              path,
            }}
            onNavigateProjects={() => {
              if (typeof window !== 'undefined') window.location.href = '/projects';
            }}
            onNavigateProject={(pId) => {
              if (typeof window !== 'undefined')
                window.location.href = `/projects/${encodeURIComponent(pId)}`;
            }}
            onNavigateRule={(pId, rId) => {
              if (typeof window !== 'undefined')
                window.location.href = `/projects/${encodeURIComponent(pId)}/rules/${encodeURIComponent(rId)}`;
            }}
          />
        </div>
      );
    }
    return this.props.children;
  }
}
