import '../styles/globals.css';
import { useEffect } from 'react';
import Head from 'next/head';

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
      <meta name="theme-color" content="#6d4aff" />
      <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    </Head>
    <Component {...pageProps} />
  </>;
}
