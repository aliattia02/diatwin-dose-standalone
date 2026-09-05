import json
import pandas as pd
import sys
import os

def excel_to_json(excel_file):
    """Convert Excel workbook back to histXXX JSON format"""
    
    # Auto-generate JSON filename
    json_file = excel_file.replace('.xlsx', '-UPDATED.json')
    
    # Read all sheets
    sheets = pd.read_excel(excel_file, sheet_name=None)
    
    main_df = sheets['Main Info']
    location_df = sheets['Location']
    hero_cards_df = sheets['Hero Cards']
    quick_facts_df = sheets['Quick Facts']
    perpetrators_df = sheets['Perpetrators']
    timeline_df = sheets['Timeline']
    war_crimes_list_df = sheets['War Crimes List']
    war_crimes_df = sheets['War Crimes Detail']
    testimonies_df = sheets['Testimonies']
    sources_df = sheets['Sources']
    exec_summary_df = sheets['Executive Summary']
    intl_law_df = sheets['International Law']
    casualties_df = sheets['Casualties']
    impact_df = sheets['Historical Impact']
    breadcrumb_df = sheets['Breadcrumb']
    
    # Optional sheets
    personalities_df = sheets.get('Personalities')
    org_context_df = sheets.get('Org Context')
    media_images_df = sheets.get('Media Images')
    media_docs_df = sheets.get('Media Docs')
    cta_df = sheets.get('CTA Buttons')
    
    # Helper function
    def get_value(df, field):
        val = df[df['Field'] == field]['Value'].values
        return val[0] if len(val) > 0 else ''
    
    # Build JSON
    data = {
        "id": get_value(main_df, 'id'),
        "event_type": get_value(main_df, 'event_type'),
        "verification_status": get_value(main_df, 'verification_status'),
        "metadata": {
            "pageTitle": get_value(main_df, 'pageTitle'),
            "description": get_value(main_df, 'description'),
            "keywords": get_value(main_df, 'keywords'),
            "lastUpdated": get_value(main_df, 'lastUpdated'),
            "author": get_value(main_df, 'author')
        },
        "date": {
            "start": get_value(main_df, 'date_start'),
            "end": get_value(main_df, 'date_end'),
            "duration_days": int(get_value(main_df, 'date_duration_days')),
            "display": get_value(main_df, 'date_display'),
            "context": get_value(main_df, 'date_context')
        },
        "location": {
            "historical": {},
            "current": {}
        },
        "breadcrumb": {
            "items": []
        },
        "hero": {
            "category": get_value(main_df, 'hero_category'),
            "title": get_value(main_df, 'hero_title'),
            "subtitle": get_value(main_df, 'hero_subtitle'),
            "metaCards": []
        },
        "quickFacts": {
            "title": "⚡ Quick Facts",
            "items": []
        },
        "brief_summary": get_value(main_df, 'brief_summary'),
        "perpetrators": [],
        "executiveSummary": {
            "title": "Executive Summary",
            "icon": "📋",
            "alert": {
                "type": "critical",
                "icon": "⚠️",
                "text": "<strong>Legal note:</strong> The 1949 Geneva Conventions were not yet in force..."
            },
            "paragraphs": []
        },
        "casualties": {
            "title": "Casualties",
            "icon": "💀",
            "deaths": get_value(main_df, 'deaths'),
            "injured": get_value(main_df, 'injured'),
            "forced_displacement": get_value(main_df, 'forced_displacement'),
            "breakdown": [],
            "alert": {
                "type": "info",
                "icon": "ℹ️",
                "text": "<strong>Sources:</strong> ..."
            }
        },
        "timeline": {
            "title": "Timeline of Events",
            "icon": "⏱️",
            "events": []
        },
        "war_crimes": [],
        "warCrimes": {
            "title": "Documented Atrocities",
            "icon": "⚠️",
            "alert": {
                "type": "warning",
                "icon": "⚠️",
                "text": "<strong>Content Warning:</strong> ..."
            },
            "crimes": []
        },
        "international_law": {
            "title": "International Law — Temporal Applicability & Classification",
            "icon": "⚖️",
            "introduction": "Legal assessment distinguishes...",
            "sections": [],
            "alert": {
                "type": "critical",
                "icon": "⚖️",
                "text": "<strong>Legal Principle:</strong> ..."
            }
        },
        "testimonies": {
            "title": "Witness Testimonies",
            "icon": "👥",
            "alert": {
                "type": "warning",
                "icon": "⚠️",
                "text": "<strong>Content Warning:</strong> ..."
            },
            "witnesses": []
        },
        "historicalImpact": {
            "title": "Historical Impact",
            "icon": "🌍",
            "sections": []
        },
        "sources": {
            "title": "Verified & Cross-Referenced Sources",
            "icon": "📚",
            "introduction": "Key references...",
            "list": [],
            "alert": {
                "type": "info",
                "icon": "ℹ️",
                "text": "<strong>Methodology:</strong> ..."
            }
        },
        "media": {
            "images": {"local": [], "remote": []},
            "documents": {"local": [], "remote": []}
        },
        "cta": {
            "title": "Help Preserve Historical Memory",
            "description": "Support ongoing documentation efforts...",
            "buttons": []
        }
    }
    
    # Populate location
    for _, row in location_df.iterrows():
        field = row['Field']
        value = row['Value']
        if field.startswith('historical_'):
            key = field.replace('historical_', '')
            if key == 'coordinates' or key == 'population_1948':
                try:
                    value = eval(value) if isinstance(value, str) and '[' in value else value
                except:
                    pass
            data['location']['historical'][key] = value
        elif field.startswith('current_'):
            key = field.replace('current_', '')
            if key == 'coordinates':
                try:
                    value = eval(value) if isinstance(value, str) and '[' in value else value
                except:
                    pass
            data['location']['current'][key] = value
    
    # Populate breadcrumb
    for _, row in breadcrumb_df.iterrows():
        data['breadcrumb']['items'].append({
            "text": row['Text'],
            "link": row['Link'] if pd.notna(row['Link']) and row['Link'] != '' else None
        })
    
    # Populate hero cards
    for _, row in hero_cards_df.iterrows():
        data['hero']['metaCards'].append({
            "icon": row['Icon'],
            "label": row['Label'],
            "value": row['Value'],
            "detail": row['Detail'] if pd.notna(row['Detail']) and row['Detail'] != '' else None
        })
    
    # Populate quick facts
    for _, row in quick_facts_df.iterrows():
        data['quickFacts']['items'].append({
            "label": row['Label'],
            "value": row['Value']
        })
    
    # Populate perpetrators
    for _, row in perpetrators_df.iterrows():
        if pd.notna(row['Perpetrator']) and row['Perpetrator'] != '':
            data['perpetrators'].append(row['Perpetrator'])
    
    # Populate personalities (if exists)
    if personalities_df is not None:
        data['personalities'] = {
            "title": "Key Individuals Involved",
            "commanders": [],
            "witnesses_critics": [],
            "organizational_context": {}
        }
        
        for _, row in personalities_df.iterrows():
            person = {
                "name": row['Name'],
                "name_hebrew": row['Name Hebrew/Arabic'] if pd.notna(row['Name Hebrew/Arabic']) else '',
                "birth_death": row['Birth-Death'],
                "role": row['Role'],
                "responsibility": row['Responsibility'],
                "later_positions": [
                    p for p in [row.get('Later Position 1'), row.get('Later Position 2'), row.get('Later Position 3')]
                    if pd.notna(p) and p != ''
                ],
                "accountability": row.get('Accountability', ''),
                "notes": row.get('Notes', '')
            }
            if row['Type'] == 'commander':
                data['personalities']['commanders'].append(person)
            else:
                data['personalities']['witnesses_critics'].append(person)
        
        if org_context_df is not None:
            for _, row in org_context_df.iterrows():
                data['personalities']['organizational_context'][row['Organization']] = row['Description']
    
    # Populate timeline
    for _, row in timeline_df.iterrows():
        data['timeline']['events'].append({
            "time": row['Time'],
            "title": row['Title'],
            "description": row['Description'],
            "source": row['Source'] if pd.notna(row['Source']) else ''
        })
    
    # Populate war crimes list
    for _, row in war_crimes_list_df.iterrows():
        if pd.notna(row['War Crime']) and row['War Crime'] != '':
            data['war_crimes'].append(row['War Crime'])
    
    # Populate war crimes detail
    for _, row in war_crimes_df.iterrows():
        data['warCrimes']['crimes'].append({
            "icon": row['Icon'],
            "title": row['Title'],
            "description": row['Description'],
            "sourceLink": row['Source Link'] if pd.notna(row['Source Link']) and row['Source Link'] != '' else None,
            "sourceText": row['Source Text'] if pd.notna(row['Source Text']) and row['Source Text'] != '' else None
        })
    
    # Populate testimonies
    for _, row in testimonies_df.iterrows():
        data['testimonies']['witnesses'].append({
            "initials": row['Initials'],
            "name": row['Name'],
            "role": row['Role'],
            "testimony": row['Testimony'],
            "source": row['Source'],
            "sourceLink": row['Source Link'] if pd.notna(row['Source Link']) else ''
        })
    
    # Populate sources
    for _, row in sources_df.iterrows():
        data['sources']['list'].append({
            "icon": row['Icon'],
            "name": row['Name'],
            "type": row['Type'],
            "description": row['Description'],
            "link": row['Link'] if pd.notna(row['Link']) and row['Link'] != '' else None,
            "verified": bool(row['Verified'])
        })
    
    # Populate executive summary
    data['executiveSummary']['paragraphs'] = exec_summary_df['Text'].tolist()
    
    # Populate international law
    current_heading = None
    current_violations = []
    for _, row in intl_law_df.iterrows():
        if row['Heading'] != current_heading:
            if current_heading is not None:
                data['international_law']['sections'].append({
                    "heading": current_heading,
                    "violations": current_violations
                })
            current_heading = row['Heading']
            current_violations = []
        current_violations.append(row['Violation'])
    if current_heading:
        data['international_law']['sections'].append({
            "heading": current_heading,
            "violations": current_violations
        })
    
    # Populate casualties
    for _, row in casualties_df.iterrows():
        data['casualties']['breakdown'].append({
            "type": row['Type'],
            "number": row['Number'],
            "label": row['Label'],
            "detail": row['Detail']
        })
    
    # Populate historical impact
    current_heading = None
    current_items = []
    for _, row in impact_df.iterrows():
        if row['Heading'] != current_heading:
            if current_heading is not None:
                data['historicalImpact']['sections'].append({
                    "heading": current_heading,
                    "items": current_items
                })
            current_heading = row['Heading']
            current_items = []
        current_items.append(row['Item'])
    if current_heading:
        data['historicalImpact']['sections'].append({
            "heading": current_heading,
            "items": current_items
        })
    
    # Populate media
    if media_images_df is not None:
        for _, row in media_images_df.iterrows():
            data['media']['images'][row['Type']].append(row['Source'])
    
    if media_docs_df is not None:
        for _, row in media_docs_df.iterrows():
            data['media']['documents'][row['Type']].append(row['Source'])
    
    # Populate CTA
    if cta_df is not None:
        for _, row in cta_df.iterrows():
            button = {
                "text": row['Text'],
                "link": row['Link'],
                "type": row['Type']
            }
            if pd.notna(row.get('Action')) and row['Action'] != '':
                button['action'] = row['Action']
            data['cta']['buttons'].append(button)
    
    # Write JSON
    with open(json_file, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    
    print(f"✅ JSON file created: {json_file}")
    print(f"📁 Original: {excel_file}")
    print(f"📁 Output: {json_file}")

# Usage
if __name__ == "__main__":
    if len(sys.argv) > 1:
        excel_file = sys.argv[1]
    else:
        # Auto-detect
        if os.path.exists('deir-yassin-1948.xlsx'):
            excel_file = 'deir-yassin-1948.xlsx'
        elif os.path.exists('lydda-death-march-1948.xlsx'):
            excel_file = 'lydda-death-march-1948.xlsx'
        else:
            print("❌ No Excel file found. Usage: python excel_to_json_universal.py <filename.xlsx>")
            sys.exit(1)
    
    excel_to_json(excel_file)