function providerDetails(value) {
  const provider = String(value || '').toLowerCase();
  if (provider.includes('groq')) return { id: 'groq', label: 'Groq' };
  if (provider.includes('gemini') || provider.includes('google')) return { id: 'gemini', label: 'Gemini' };
  return { id: 'openai', label: 'OpenAI' };
}

export default function ProviderLogo({ provider, showLabel = true, compact = false, className = '' }) {
  const details = providerDetails(provider);
  return <span className={`provider-identity provider-${details.id}${compact ? ' compact' : ''}${className ? ` ${className}` : ''}`} title={details.label}>
    <span className="provider-logo" aria-hidden="true">
      {details.id === 'gemini' && <svg viewBox="0 0 32 32"><path d="M16 2c1.4 7.7 6.3 12.6 14 14-7.7 1.4-12.6 6.3-14 14C14.6 22.3 9.7 17.4 2 16 9.7 14.6 14.6 9.7 16 2Z"/></svg>}
      {details.id === 'groq' && <svg viewBox="0 0 32 32"><path d="M25.5 11.1A11 11 0 1 0 25.2 22H17v-5h13v3.3A15.5 15.5 0 1 1 29.6 9Z"/><circle cx="16" cy="16" r="3.4"/></svg>}
      {details.id === 'openai' && <svg viewBox="0 0 32 32"><g fill="none" stroke="currentColor" strokeWidth="2.5"><ellipse cx="16" cy="10" rx="8" ry="5"/><ellipse cx="16" cy="10" rx="8" ry="5" transform="rotate(60 16 16)"/><ellipse cx="16" cy="10" rx="8" ry="5" transform="rotate(120 16 16)"/></g><circle cx="16" cy="16" r="3.2"/></svg>}
    </span>
    {showLabel && <span className="provider-name">{details.label}</span>}
  </span>;
}
