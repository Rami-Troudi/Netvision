import React from 'react';
import '../src/style.css';
import 'maplibre-gl/dist/maplibre-gl.css';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    // Log the error to console so we can diagnose crashes in production.
    // In a real deployment this should forward to an error tracking service.
    console.error('Unhandled error in React tree', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '24px', fontFamily: 'IBM Plex Sans, Segoe UI, sans-serif' }}>
          <h1 style={{ marginBottom: '8px' }}>Something went wrong</h1>
          <p style={{ color: '#666' }}>Reload the page or contact support if this persists.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function MyApp({ Component, pageProps }) {
  return (
    <ErrorBoundary>
      <Component {...pageProps} />
    </ErrorBoundary>
  );
}
