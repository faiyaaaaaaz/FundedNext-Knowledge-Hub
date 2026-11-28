import '../styles/globals.css';
import '../styles/workspace.css';
import '../styles/usability.css';
import '../styles/knowledge-map.css';
import '../styles/audits.css';
import '../styles/refresh.css';
import '../styles/okr-theme.css';
import '../styles/scorecards.css';
import '../styles/scorecard-modal.css';
import { useEffect } from 'react';
import Head from 'next/head';
import InteractionFeedback from '../components/InteractionFeedback';
import AppVersionGuard from '../components/AppVersionGuard';

export default function App({ Component, pageProps }) {
  useEffect(() => {
    try {
      const t = localStorage.getItem('theme');
      if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    } catch (e) {}
  }, []);
  return <>
    <Head>
      <title>FundedNext Support Assistant</title>
      <meta name="description" content="FundedNext internal support knowledge assistant" />
      <meta name="theme-color" content="#245d4b" />
      <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" />
    </Head>
    <Component {...pageProps} />
    <AppVersionGuard />
    <InteractionFeedback />
  </>;
}
