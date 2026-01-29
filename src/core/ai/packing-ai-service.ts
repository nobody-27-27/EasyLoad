/**
 * AI-Assisted Packing Optimization Service
 * Uses Claude API to analyze packing problems and suggest optimal placements
 */

export interface PackingState {
  container: {
    width: number;
    length: number;
    height: number;
  };
  placedCylinders: Array<{
    diameter: number;
    length: number;
    position: { x: number; y: number; z: number };
    orientation: 'vertical' | 'horizontal' | 'rotated';
  }>;
  unplacedCylinders: Array<{
    diameter: number;
    length: number;
    name: string;
  }>;
  yGaps: Array<{ start: number; end: number }>;
  zLevels: number[];
}

export interface AIPlacementSuggestion {
  cylinderIndex: number;
  position: { x: number; y: number; z: number };
  orientation: 'vertical' | 'horizontal' | 'rotated';
  reasoning: string;
  confidence: number;
}

export interface AIAnalysisResult {
  suggestions: AIPlacementSuggestion[];
  analysis: string;
  possibleToFitAll: boolean;
  recommendedStrategy: string;
}

class PackingAIService {
  private apiKey: string | null = null;
  private apiEndpoint = 'https://api.anthropic.com/v1/messages';

  setApiKey(key: string) {
    this.apiKey = key;
    localStorage.setItem('claude_api_key', key);
  }

  getApiKey(): string | null {
    if (!this.apiKey) {
      this.apiKey = localStorage.getItem('claude_api_key');
    }
    return this.apiKey;
  }

  hasApiKey(): boolean {
    return !!this.getApiKey();
  }

  async analyzePackingProblem(state: PackingState): Promise<AIAnalysisResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('Claude API key not configured. Please set your API key.');
    }

    const prompt = this.buildAnalysisPrompt(state);

    try {
      const response = await fetch(this.apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 2000,
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(`API error: ${error.error?.message || response.statusText}`);
      }

      const data = await response.json();
      const content = data.content[0].text;

      return this.parseAIResponse(content, state);
    } catch (error) {
      console.error('AI analysis failed:', error);
      throw error;
    }
  }

  private buildAnalysisPrompt(state: PackingState): string {
    const { container, placedCylinders, unplacedCylinders, yGaps, zLevels } = state;

    return `You are a 3D bin packing optimization expert. Analyze this cylinder packing problem and suggest where to place the remaining cylinder(s).

CONTAINER DIMENSIONS:
- Width (X): ${container.width} cm
- Length (Y): ${container.length} cm
- Height (Z): ${container.height} cm

ALREADY PLACED: ${placedCylinders.length} cylinders
${placedCylinders.slice(-10).map((c, i) =>
  `  ${i + 1}. D${c.diameter} L${c.length} at (${c.position.x.toFixed(0)}, ${c.position.y.toFixed(0)}, ${c.position.z.toFixed(0)}) ${c.orientation}`
).join('\n')}
${placedCylinders.length > 10 ? `  ... and ${placedCylinders.length - 10} more` : ''}

REMAINING TO PLACE: ${unplacedCylinders.length} cylinder(s)
${unplacedCylinders.map((c, i) =>
  `  ${i + 1}. ${c.name}: Diameter=${c.diameter}cm, Length=${c.length}cm`
).join('\n')}

AVAILABLE Y GAPS ON FLOOR: ${yGaps.map(g => `${g.start.toFixed(0)}-${g.end.toFixed(0)}cm`).join(', ') || 'None'}

Z LEVELS (tops of placed cylinders): ${zLevels.map(z => z.toFixed(0)).join(', ')}cm

For each unplaced cylinder, it can be placed in 3 orientations:
- VERTICAL: diameter in X and Y, length in Z (needs length <= ${container.height}cm)
- HORIZONTAL: diameter in X and Z, length in Y
- ROTATED: length in X, diameter in Y and Z

Analyze the geometry and respond in this exact JSON format:
{
  "possibleToFitAll": true/false,
  "analysis": "Brief explanation of the space constraints",
  "recommendedStrategy": "Description of best approach",
  "suggestions": [
    {
      "cylinderIndex": 0,
      "position": {"x": number, "y": number, "z": number},
      "orientation": "vertical" | "horizontal" | "rotated",
      "reasoning": "Why this position works",
      "confidence": 0.0-1.0
    }
  ]
}

Be precise with coordinates. Check that:
- Position + dimensions fit within container bounds
- No collision with existing cylinders
- If elevated (z>0), there's support underneath`;
  }

  private parseAIResponse(content: string, _state: PackingState): AIAnalysisResult {
    try {
      // Extract JSON from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      return {
        possibleToFitAll: parsed.possibleToFitAll ?? false,
        analysis: parsed.analysis ?? 'No analysis provided',
        recommendedStrategy: parsed.recommendedStrategy ?? 'Unknown',
        suggestions: (parsed.suggestions ?? []).map((s: any) => ({
          cylinderIndex: s.cylinderIndex ?? 0,
          position: {
            x: Number(s.position?.x ?? 0),
            y: Number(s.position?.y ?? 0),
            z: Number(s.position?.z ?? 0),
          },
          orientation: s.orientation ?? 'horizontal',
          reasoning: s.reasoning ?? '',
          confidence: Number(s.confidence ?? 0.5),
        })),
      };
    } catch (error) {
      console.error('Failed to parse AI response:', error);
      console.log('Raw response:', content);

      return {
        possibleToFitAll: false,
        analysis: content,
        recommendedStrategy: 'Could not parse AI response',
        suggestions: [],
      };
    }
  }
}

export const packingAIService = new PackingAIService();
