import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import './form.css';

const target = document.getElementById('app');
if (!target) throw new Error('#app mount target not found');

export default mount(App, { target });
