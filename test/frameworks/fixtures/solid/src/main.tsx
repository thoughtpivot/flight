import { render } from 'solid-js/web'

function App() {
    return <h1 data-testid="hello">Hello from Flight + Solid</h1>
}

render(() => <App />, document.getElementById('app')!)
