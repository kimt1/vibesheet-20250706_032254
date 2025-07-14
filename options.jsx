import React from 'react';
import ReactDOM from 'react-dom';
import Dashboard from './dashboard.jsx'; // Assuming dashboard.jsx is the main options UI
import './dashboard.css'; // Assuming styles for the dashboard are in dashboard.css

const root = ReactDOM.createRoot(document.getElementById('options-root'));
root.render(
  <React.StrictMode>
    <Dashboard />
  </React.StrictMode>
);
