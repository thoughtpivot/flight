import { render } from 'preact'

function App() {
    return <h1 data-testid="hello">Hello from Flight + Preact</h1>
}

render(<App />, document.getElementById('app')!)
