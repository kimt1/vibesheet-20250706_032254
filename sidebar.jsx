const SIDEBAR_SECTIONS = [
  { id: 'dashboard', label: { en: 'Dashboard', es: 'Tablero' }, icon: '?' },
  { id: 'forms', label: { en: 'Forms', es: 'Formularios' }, icon: '?' },
  { id: 'settings', label: { en: 'Settings', es: 'Configuración' }, icon: '??' },
];

const THEMES = ['light', 'dark'];
const LANGUAGES = ['en', 'es'];

export default function Sidebar(props) {
  const [activeSection, setActiveSection] = useState(props.activeSection || 'dashboard');
  const [theme, setTheme] = useState(props.theme || 'light');
  const [locale, setLocale] = useState(props.locale || 'en');
  const [notification, setNotification] = useState(null);

  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 2400);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  function handleSectionChange(sectionId) {
    setActiveSection(sectionId);
    if (props.onSectionChange) props.onSectionChange(sectionId);
    triggerNotification(
      locale === 'es'
        ? 'Sección cambiada'
        : 'Section changed'
    );
  }

  function triggerNotification(message) {
    setNotification(message);
    if (props.onNotification) props.onNotification(message);
  }

  function toggleTheme(nextTheme) {
    const selectedTheme = nextTheme || (theme === 'light' ? 'dark' : 'light');
    setTheme(selectedTheme);
    if (props.onThemeChange) props.onThemeChange(selectedTheme);
    triggerNotification(
      locale === 'es'
        ? selectedTheme === 'dark' ? 'Tema oscuro' : 'Tema claro'
        : selectedTheme === 'dark' ? 'Dark theme' : 'Light theme'
    );
  }

  function switchLanguage(nextLocale) {
    const selectedLocale = nextLocale || (locale === 'en' ? 'es' : 'en');
    setLocale(selectedLocale);
    if (props.onLocaleChange) props.onLocaleChange(selectedLocale);
    triggerNotification(
      selectedLocale === 'es'
        ? 'Idioma cambiado a Español'
        : 'Language switched to English'
    );
  }

  return (
    <aside className={`sidebar sidebar--${theme}`}>
      <div className="sidebar__header">
        <span className="sidebar__logo">Form Master</span>
      </div>
      <nav className="sidebar__nav">
        {SIDEBAR_SECTIONS.map(section => (
          <button
            key={section.id}
            className={`sidebar__nav-item${activeSection === section.id ? ' active' : ''}`}
            aria-current={activeSection === section.id}
            onClick={() => handleSectionChange(section.id)}
            tabIndex={0}
          >
            <span className="sidebar__nav-icon">{section.icon}</span>
            <span className="sidebar__nav-label">{section.label[locale]}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar__controls">
        <button
          className="sidebar__toggle-theme"
          onClick={() => toggleTheme()}
          aria-label={locale === 'es' ? 'Cambiar tema' : 'Switch theme'}
        >
          {theme === 'light' ? '?' : '?'}
        </button>
        <button
          className="sidebar__switch-lang"
          onClick={() => switchLanguage()}
          aria-label={locale === 'es' ? 'Cambiar idioma' : 'Switch language'}
        >
          {locale === 'en' ? 'ES' : 'EN'}
        </button>
      </div>
      {notification &&
        <div className="sidebar__notification" role="alert">
          {notification}
        </div>
      }
    </aside>
  );
}
