import React from 'react';
import ReactDOM from 'react-dom';
import Sidebar from './sidebar.jsx'; // Assuming sidebar.jsx is the main popup UI
import './sidebar.css'; // Assuming styles for the sidebar are in sidebar.css

const root = ReactDOM.createRoot(document.getElementById('popup-root'));
root.render(
  <React.StrictMode>
    <Sidebar />
  </React.StrictMode>
);
