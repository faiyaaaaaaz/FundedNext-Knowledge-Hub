import '../styles/globals.css';
import { useEffect } from 'react';

export default function App({ Component, pageProps }) {
  useEffect(() => {
    try {
      const t = localStorage.getItem('theme');
      if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    } catch (e) {}
  }, []);
  return <Component {...pageProps} />;
}
